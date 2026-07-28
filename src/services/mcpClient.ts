import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import { getScopeKey } from "./tags.js";
import type {
  IMemoryBackendClient,
  MemoryScopeContext,
  MemoryType,
  MemorySector,
  SearchMemoriesResult,
  AddMemoryResult,
  ListMemoriesResult,
  DeleteMemoryResult,
  ProfileResult,
  MemoryItem,
} from "../types/index.js";

const DEFAULT_CALL_TIMEOUT_MS = 30000;
// The initial spawn may include `npx -y openmemory-js` downloading the
// package on a cold npm cache (measured at ~26s), so the connect budget is
// deliberately much larger than the per-call one.
const DEFAULT_CONNECT_TIMEOUT_MS = 60000;

/**
 * Timeout knobs are read off CONFIG defensively: src/config.ts owns the
 * config schema and will declare `mcpTimeout` / `mcpConnectTimeout` there.
 * Until it does, this narrow local cast lets us honor them if present
 * without depending on the declaration.
 */
interface McpTimeoutConfig {
  mcpTimeout?: number;
  mcpConnectTimeout?: number;
}

function timeoutFor(key: keyof McpTimeoutConfig, fallback: number): number {
  const value = (CONFIG as typeof CONFIG & McpTimeoutConfig)[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Same idiom as the REST client's withTimeout (src/services/client.ts),
 * duplicated intentionally so the two backends stay independent. Adds an
 * operation label so timeout errors say what actually hung, and clears the
 * timer so a fast success doesn't hold a pending handle open.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        log("McpMemoryClient: timeout", { operation, timeoutMs: ms });
        reject(new Error(`${operation} timed out after ${ms}ms`));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

interface ToolCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface QueryToolMatch {
  id: string;
  score?: number;
  primary_sector?: string;
  sectors?: string[];
  salience?: number;
  last_seen_at?: number;
  content: string;
}

interface QueryToolResponse {
  contextual?: QueryToolMatch[];
}

interface StoreToolResponse {
  hsg?: { id: string; primary_sector?: string };
}

interface ListToolItem {
  id: string;
  primary_sector?: string;
  salience?: number;
  last_seen_at?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  content_preview: string;
}

interface ListToolResponse {
  items: ListToolItem[];
}

function extractJson<T>(result: ToolCallResult): T | null {
  for (const block of result.content) {
    if (block.type !== "text" || !block.text) continue;
    try {
      return JSON.parse(block.text) as T;
    } catch {
      continue;
    }
  }
  return null;
}

function resultToText(result: ToolCallResult): string {
  const textBlock = result.content.find((b) => b.type === "text" && b.text);
  return textBlock?.text ?? "MCP tool call failed";
}

/**
 * MCP backend: spawns OpenMemory's own MCP server (`openmemory-js mcp`)
 * as a local stdio child process. Unlike the REST API, the stdio MCP
 * transport has no per-request API key, so OpenMemory trusts whatever
 * user_id the caller passes.
 *
 * As of openmemory-js@1.3.x (the version `npx openmemory-js` currently
 * installs), the MCP tools only take a flat `user_id` — there's no
 * `project_id` param or `openmemory_store_project` tool yet (that exists
 * on OpenMemory's unreleased main branch, not on npm). So user-vs-project
 * scoping here is done the same way the old REST client used to do it:
 * project scope is folded into a single compound user_id string
 * (see getScopeKey in tags.ts). Once openmemory-js publishes native
 * project_id support, this can switch to passing project_id directly.
 */
export class McpMemoryClient implements IMemoryBackendClient {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  private async getClient(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const connectTimeout = timeoutFor("mcpConnectTimeout", DEFAULT_CONNECT_TIMEOUT_MS);
      log("McpMemoryClient: spawning server", {
        command: CONFIG.mcpCommand,
        args: CONFIG.mcpArgs,
        connectTimeoutMs: connectTimeout,
      });

      const transport = new StdioClientTransport({
        command: CONFIG.mcpCommand,
        args: CONFIG.mcpArgs,
        env: { ...(process.env as Record<string, string>), ...CONFIG.mcpEnv },
        stderr: "pipe",
      });

      const client = new Client({ name: "opencode-openmemory", version: "0.2.0" }, { capabilities: {} });

      try {
        await withTimeout(client.connect(transport), connectTimeout, "MCP server connect");
      } catch (error) {
        // Tear down the half-spawned child: on a timeout the `npx` process is
        // still alive and would otherwise be orphaned for the session.
        log("McpMemoryClient: connect failed, tearing down transport", {
          pid: transport.pid,
          error: error instanceof Error ? error.message : String(error),
        });
        // Not awaited: killing the child can take seconds on some platforms
        // and the caller's timeout budget is already spent.
        void client
          .close()
          .catch(() => {})
          .then(() => transport.close())
          .catch(() => {});
        throw error;
      }

      transport.stderr?.on("data", (chunk: Buffer) => {
        log("McpMemoryClient: server stderr", { message: chunk.toString().trim() });
      });

      client.onclose = () => {
        log("McpMemoryClient: connection closed");
        if (this.client === client) this.client = null;
      };

      this.client = client;
      log("McpMemoryClient: connected");
      return client;
    })();

    try {
      return await this.connecting;
    } catch (error) {
      // Leave both slots null so the next call retries a fresh spawn rather
      // than inheriting this rejected promise.
      this.client = null;
      throw error;
    } finally {
      this.connecting = null;
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const client = await this.getClient();
    return withTimeout(
      client.callTool({ name, arguments: args }) as Promise<ToolCallResult>,
      timeoutFor("mcpTimeout", DEFAULT_CALL_TIMEOUT_MS),
      `MCP tool call ${name}`
    );
  }

  async searchMemories(
    query: string,
    scope: MemoryScopeContext,
    options?: { limit?: number; minSalience?: number; sector?: MemorySector }
  ): Promise<SearchMemoriesResult> {
    log("McpMemoryClient.searchMemories", { query: query.slice(0, 50), scope });

    try {
      const result = await this.callTool("openmemory_query", {
        query,
        k: options?.limit ?? CONFIG.maxMemories,
        sector: options?.sector,
        min_salience: options?.minSalience,
        user_id: getScopeKey(scope),
      });

      if (result.isError) {
        return { success: false, results: [], total: 0, error: resultToText(result) };
      }

      const data = extractJson<QueryToolResponse>(result);
      const matches = data?.contextual ?? [];
      const memories: MemoryItem[] = matches.map((m) => ({
        id: m.id,
        content: m.content,
        score: m.score,
        salience: m.salience,
        sector: m.primary_sector as MemorySector | undefined,
        createdAt: m.last_seen_at ? new Date(m.last_seen_at).toISOString() : undefined,
      }));

      return { success: true, results: memories, total: memories.length };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("McpMemoryClient.searchMemories: error", { error: errorMessage });
      return { success: false, results: [], total: 0, error: errorMessage };
    }
  }

  async addMemory(
    content: string,
    scope: MemoryScopeContext,
    options?: { type?: MemoryType; tags?: string[]; metadata?: Record<string, unknown> }
  ): Promise<AddMemoryResult> {
    log("McpMemoryClient.addMemory", { contentLength: content.length, scope });

    try {
      const metadata = { ...options?.metadata, type: options?.type, source: "opencode-openmemory" };

      const result = await this.callTool("openmemory_store", {
        content,
        tags: options?.tags,
        metadata,
        user_id: getScopeKey(scope),
      });

      if (result.isError) {
        return { success: false, error: resultToText(result) };
      }

      const data = extractJson<StoreToolResponse>(result);
      return { success: true, id: data?.hsg?.id, sector: data?.hsg?.primary_sector as MemorySector | undefined };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("McpMemoryClient.addMemory: error", { error: errorMessage });
      return { success: false, error: errorMessage };
    }
  }

  async listMemories(
    scope: MemoryScopeContext,
    options?: { limit?: number; sector?: MemorySector }
  ): Promise<ListMemoriesResult> {
    log("McpMemoryClient.listMemories", { scope, limit: options?.limit });

    try {
      const result = await this.callTool("openmemory_list", {
        limit: options?.limit ?? CONFIG.maxProjectMemories,
        sector: options?.sector,
        user_id: getScopeKey(scope),
      });

      if (result.isError) {
        return { success: false, memories: [], error: resultToText(result) };
      }

      const data = extractJson<ListToolResponse>(result);
      const items = data?.items ?? [];
      // Note: openmemory_list only returns a 240-char content preview,
      // not the full memory content (the REST /memory/all endpoint
      // returns full content; this tool does not have an equivalent).
      const memories: MemoryItem[] = items.map((i) => ({
        id: i.id,
        content: i.content_preview,
        salience: i.salience,
        sector: i.primary_sector as MemorySector | undefined,
        tags: i.tags,
        metadata: i.metadata,
        createdAt: i.last_seen_at ? new Date(i.last_seen_at).toISOString() : undefined,
      }));

      return { success: true, memories, total: memories.length };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("McpMemoryClient.listMemories: error", { error: errorMessage });
      return { success: false, memories: [], error: errorMessage };
    }
  }

  async deleteMemory(memoryId: string, scope: MemoryScopeContext): Promise<DeleteMemoryResult> {
    log("McpMemoryClient.deleteMemory", { memoryId });

    try {
      const result = await this.callTool("openmemory_delete", {
        id: memoryId,
        user_id: getScopeKey(scope),
      });

      if (result.isError) {
        return { success: false, error: resultToText(result) };
      }

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("McpMemoryClient.deleteMemory: error", { error: errorMessage });
      return { success: false, error: errorMessage };
    }
  }

  async reinforceMemory(memoryId: string, boost: number = 0.1): Promise<{ success: boolean; error?: string }> {
    log("McpMemoryClient.reinforceMemory", { memoryId, boost });

    try {
      const result = await this.callTool("openmemory_reinforce", { id: memoryId, boost });

      if (result.isError) {
        return { success: false, error: resultToText(result) };
      }

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("McpMemoryClient.reinforceMemory: error", { error: errorMessage });
      return { success: false, error: errorMessage };
    }
  }

  async getProfile(scope: MemoryScopeContext, query?: string): Promise<ProfileResult> {
    log("McpMemoryClient.getProfile", { scope });

    // OpenMemory's MCP tools don't expose a dedicated profile endpoint,
    // and query results only carry last_seen_at (not a creation time).
    // We approximate "static" (long-standing) vs "dynamic" (recent)
    // facts using last_seen_at as a proxy for recency.
    const result = await this.searchMemories(query || "preferences style workflow", { userId: scope.userId }, {
      limit: CONFIG.maxProfileItems * 2,
    });

    if (!result.success) {
      return { success: false, error: result.error };
    }

    const now = Date.now();
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;

    const staticFacts = result.results
      .filter((m) => m.createdAt && new Date(m.createdAt).getTime() < oneWeekAgo)
      .slice(0, CONFIG.maxProfileItems)
      .map((m) => m.content);

    const dynamicFacts = result.results
      .filter((m) => !m.createdAt || new Date(m.createdAt).getTime() >= oneWeekAgo)
      .slice(0, CONFIG.maxProfileItems)
      .map((m) => m.content);

    return { success: true, profile: { static: staticFacts, dynamic: dynamicFacts } };
  }

  async close(): Promise<void> {
    if (this.client) {
      log("McpMemoryClient: closing");
      await this.client.close().catch(() => {});
      this.client = null;
    }
  }
}

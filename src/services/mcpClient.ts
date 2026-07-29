import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawnSync } from "node:child_process";
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

interface GetToolResponse {
  id?: string;
  content?: string;
}

interface ListToolItem {
  id: string;
  project_id?: string;
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
 * PIDs of MCP servers we have spawned and not yet closed.
 *
 * `dispose()` handles orderly shutdown, but it never runs when the host dies
 * abruptly — a crash, a kill, or a stopped background job. Without this the
 * child survives its parent indefinitely, holding a SQLite connection open;
 * in testing, 17 such servers accumulated over a day.
 */
const liveServerPids = new Set<number>();
let exitHandlersInstalled = false;

/**
 * Kills a spawned server and everything below it, synchronously.
 *
 * One `process.kill(pid)` is not enough. `StdioClientTransport` spawns via
 * cross-spawn, so on Windows the pid we hold is a `cmd`/`npx` wrapper and the
 * real `openmemory-js` process is its child — killing the wrapper leaves the
 * grandchild running, reparented and unreachable. Measured directly: the pid
 * the transport reported was the *parent* of the surviving server process.
 *
 * Must stay synchronous so it can run inside `process.on("exit")`, which
 * permits no async work.
 */
function killProcessTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    // POSIX: the child is normally its own group leader here, so signal the
    // group first to catch descendants, then fall back to the bare pid.
    try {
      process.kill(-pid);
    } catch {
      process.kill(pid);
    }
  } catch {
    // Already gone, or not ours any more — nothing to do either way.
  }
}

function killLiveServers(): void {
  for (const pid of liveServerPids) killProcessTree(pid);
  liveServerPids.clear();
}

function installExitHandlers(): void {
  if (exitHandlersInstalled) return;
  exitHandlersInstalled = true;

  process.once("exit", killLiveServers);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      killLiveServers();
      // Attaching a signal listener suppresses Node's default
      // terminate-on-signal. We are a plugin inside someone else's process,
      // so only reproduce that default when nothing else is listening —
      // otherwise the host owns the shutdown and forcing an exit here would
      // cut its own cleanup short. The count includes this listener.
      if (process.listenerCount(signal) <= 1) {
        process.exit(signal === "SIGINT" ? 130 : 143);
      }
    });
  }
}

/** OpenMemory's reserved bucket for memories that belong to no one project. */
const GLOBAL_PROJECT_ID = "system_global";

/**
 * How this connection expresses "user X, project Y" to the server.
 *
 * - `project`: the server takes a `project_id` argument, so scopes map
 *   directly onto it. Real per-project isolation, verified against a live
 *   server: a query filtered to project B does not see project A's memories,
 *   while `system_global` entries stay visible to every project.
 * - `compound`: the server predates `project_id` (openmemory-js@1.3.x on npm
 *   still does), so the project has to be folded into the `user_id` string
 *   the way the old REST client did it — see getScopeKey in tags.ts.
 */
export type ScopingMode = "project" | "compound";

/**
 * Just the user half of the identity, for tools that take no `project_id`
 * (openmemory_store, openmemory_get). Empty when the server derives the user
 * from the API key, since supplying one there is answered with a 403.
 */
export function identityArgsFor(
  scoping: ScopingMode,
  serverOwnsUserId: boolean,
  scope: MemoryScopeContext
): Record<string, unknown> {
  if (serverOwnsUserId) return {};
  return { user_id: scoping === "compound" ? getScopeKey(scope) : scope.userId };
}

/**
 * Full identity arguments for a tool call.
 *
 * In `project` mode the project rides in its own `project_id`, defaulting to
 * OpenMemory's global bucket for a scope with no project. In `compound` mode
 * there is no `project_id` to use, so user and project collapse into a single
 * opaque `user_id`.
 */
export function scopeArgsFor(
  scoping: ScopingMode,
  serverOwnsUserId: boolean,
  scope: MemoryScopeContext
): Record<string, unknown> {
  const identity = identityArgsFor(scoping, serverOwnsUserId, scope);
  if (scoping === "compound") return identity;
  return { project_id: scope.projectId ?? GLOBAL_PROJECT_ID, ...identity };
}

/**
 * MCP backend. Talks to OpenMemory either by spawning `openmemory-js mcp` as a
 * local stdio child, or over the HTTP MCP endpoint of a server that is already
 * running (set `mcpUrl`).
 *
 * The two differ in who owns identity. A stdio server has no request to carry
 * an API key, so it trusts whatever `user_id` we pass. An HTTP server derives
 * the user from the API key and rejects any mismatching `user_id` with
 * `tenant_mismatch` — but it still honours a client-supplied `project_id`,
 * which is what keeps project scoping working remotely.
 */
export class McpMemoryClient implements IMemoryBackendClient {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private pid: number | null = null;
  private scoping: ScopingMode = "compound";
  /** True when the server pins user identity to the API key (HTTP transport). */
  private serverOwnsUserId = false;

  private async getClient(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const connectTimeout = timeoutFor("mcpConnectTimeout", DEFAULT_CONNECT_TIMEOUT_MS);
      const remoteUrl = CONFIG.mcpUrl;

      if (remoteUrl) {
        log("McpMemoryClient: connecting to remote server", {
          url: remoteUrl,
          authenticated: Boolean(CONFIG.mcpHeaders),
          connectTimeoutMs: connectTimeout,
        });
      } else {
        log("McpMemoryClient: spawning server", {
          command: CONFIG.mcpCommand,
          args: CONFIG.mcpArgs,
          connectTimeoutMs: connectTimeout,
        });
      }

      const transport = remoteUrl
        ? new StreamableHTTPClientTransport(new URL(remoteUrl), {
            requestInit: CONFIG.mcpHeaders ? { headers: CONFIG.mcpHeaders } : undefined,
          })
        : new StdioClientTransport({
            command: CONFIG.mcpCommand,
            args: CONFIG.mcpArgs,
            env: { ...(process.env as Record<string, string>), ...CONFIG.mcpEnv },
            stderr: "pipe",
          });

      // A remote server derives the user from the API key and 403s on any
      // user_id we supply, so we must leave it off entirely.
      this.serverOwnsUserId = Boolean(remoteUrl);

      // pid and stderr exist only on the stdio transport; there is no child
      // process to track or reap when we are talking to a remote server.
      const stdioTransport = remoteUrl ? null : (transport as StdioClientTransport);

      const client = new Client({ name: "opencode-openmemory", version: "0.2.0" }, { capabilities: {} });

      try {
        await withTimeout(client.connect(transport), connectTimeout, "MCP server connect");
      } catch (error) {
        // Tear down the half-spawned child: on a timeout the `npx` process is
        // still alive and would otherwise be orphaned for the session.
        const failedPid = stdioTransport?.pid ?? null;
        log("McpMemoryClient: connect failed, tearing down transport", {
          pid: failedPid,
          error: error instanceof Error ? error.message : String(error),
        });
        // Track it while teardown runs. Teardown is not awaited (killing the
        // child can take seconds and the caller's budget is already spent),
        // so without this a host exit during that window would orphan it.
        if (failedPid !== null) {
          installExitHandlers();
          liveServerPids.add(failedPid);
        }
        void client
          .close()
          .catch(() => {})
          .then(() => transport.close())
          .catch(() => {})
          .finally(() => {
            if (failedPid !== null) liveServerPids.delete(failedPid);
          });
        throw error;
      }

      stdioTransport?.stderr?.on("data", (chunk: Buffer) => {
        log("McpMemoryClient: server stderr", { message: chunk.toString().trim() });
      });

      // Track the child so an abrupt host exit still takes it down. Untracked
      // again on close, so a recycled pid can never be signalled by mistake.
      const pid = stdioTransport?.pid ?? null;
      if (pid !== null) {
        installExitHandlers();
        liveServerPids.add(pid);
        this.pid = pid;
      }

      await this.detectScoping(client);

      client.onclose = () => {
        log("McpMemoryClient: connection closed");
        if (pid !== null) liveServerPids.delete(pid);
        if (this.client === client) {
          this.client = null;
          this.pid = null;
        }
      };

      this.client = client;
      log("McpMemoryClient: connected", { pid });
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

  /**
   * Asks the server which scoping vocabulary it speaks. Newer builds expose
   * `openmemory_store_project` and accept `project_id`; openmemory-js@1.3.x on
   * npm does not, and needs the project folded into `user_id` instead.
   *
   * A failure here is not fatal — we fall back to the compound form, which
   * every version understands.
   */
  private async detectScoping(client: Client): Promise<void> {
    try {
      const { tools } = await withTimeout(
        client.listTools(),
        timeoutFor("mcpTimeout", DEFAULT_CALL_TIMEOUT_MS),
        "MCP listTools"
      );
      const names = new Set(tools.map((t) => t.name));
      const queryAcceptsProject = Boolean(
        tools.find((t) => t.name === "openmemory_query")?.inputSchema?.properties?.["project_id"]
      );
      this.scoping =
        names.has("openmemory_store_project") && queryAcceptsProject ? "project" : "compound";
    } catch (error) {
      this.scoping = "compound";
      log("McpMemoryClient: scoping detection failed, assuming compound", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    log("McpMemoryClient: scoping mode", {
      scoping: this.scoping,
      serverOwnsUserId: this.serverOwnsUserId,
    });
  }

  /**
   * Ensures the connection — and therefore the detected scoping mode — is
   * established before any scope arguments are built.
   *
   * `scoping` and `serverOwnsUserId` are only known once we have handshaked
   * and called listTools. Callers that read them while building a request
   * must await this first, or the very first call of a session silently uses
   * the pessimistic defaults: it would store to the global bucket instead of
   * the project one, making that memory visible to every project.
   */
  private async ready(): Promise<void> {
    await this.getClient();
  }

  private scopeArgs(scope: MemoryScopeContext): Record<string, unknown> {
    return scopeArgsFor(this.scoping, this.serverOwnsUserId, scope);
  }

  private identityArgs(scope: MemoryScopeContext): Record<string, unknown> {
    return identityArgsFor(this.scoping, this.serverOwnsUserId, scope);
  }

  /** Whether a project-scoped write should use openmemory_store_project. */
  private useProjectStore(scope: MemoryScopeContext): boolean {
    return this.scoping === "project" && Boolean(scope.projectId);
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
      await this.ready();
      const result = await this.callTool("openmemory_query", {
        query,
        k: options?.limit ?? CONFIG.maxMemories,
        sector: options?.sector,
        min_salience: options?.minSalience,
        ...this.scopeArgs(scope),
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
      // Must precede the scoping reads below.
      await this.ready();

      const metadata = { ...options?.metadata, type: options?.type, source: "opencode-openmemory" };

      // openmemory_store always files under system_global and takes no
      // project_id, so a project-scoped write has to go through
      // openmemory_store_project. Without project support there is only the
      // one tool, and the whole scope rides in user_id instead.
      const useProjectTool = this.useProjectStore(scope);
      const result = await this.callTool(
        useProjectTool ? "openmemory_store_project" : "openmemory_store",
        {
          content,
          tags: options?.tags,
          metadata,
          // A global write must not carry project_id — openmemory_store
          // rejects nothing but ignores it, and sending it invites confusion.
          ...(useProjectTool ? this.scopeArgs(scope) : this.identityArgs(scope)),
        }
      );

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

  /**
   * Resolves a memory's full text, since list results are previews.
   * Falls back to the preview rather than failing the whole listing: a
   * truncated memory is still more useful than none.
   */
  private async fetchFullContent(
    memoryId: string,
    scope: MemoryScopeContext,
    preview: string
  ): Promise<string> {
    try {
      await this.ready();
      const result = await this.callTool("openmemory_get", {
        id: memoryId,
        ...this.identityArgs(scope),
      });

      if (result.isError) return preview;

      const data = extractJson<GetToolResponse>(result);
      return data?.content || preview;
    } catch (error) {
      log("McpMemoryClient.fetchFullContent: falling back to preview", {
        memoryId,
        error: error instanceof Error ? error.message : String(error),
      });
      return preview;
    }
  }

  async listMemories(
    scope: MemoryScopeContext,
    options?: { limit?: number; sector?: MemorySector }
  ): Promise<ListMemoriesResult> {
    log("McpMemoryClient.listMemories", { scope, limit: options?.limit });

    try {
      await this.ready();
      const result = await this.callTool("openmemory_list", {
        limit: options?.limit ?? CONFIG.maxProjectMemories,
        sector: options?.sector,
        ...this.scopeArgs(scope),
      });

      if (result.isError) {
        return { success: false, memories: [], error: resultToText(result) };
      }

      const data = extractJson<ListToolResponse>(result);
      let items = data?.items ?? [];

      // A project-filtered list also returns system_global entries. Those are
      // already injected via the user scope, so keeping them here would spend
      // the context budget on the same memory twice. Items without a
      // project_id are kept — older servers don't report one.
      if (this.scoping === "project" && scope.projectId) {
        items = items.filter((i) => !i.project_id || i.project_id === scope.projectId);
      }

      // openmemory_list only returns a 240-char `content_preview`. These
      // memories get injected into the model's context as project
      // knowledge, so a silently truncated one is worse than an extra
      // round trip — backfill the full text via openmemory_get.
      const memories: MemoryItem[] = await Promise.all(
        items.map(async (i) => ({
          id: i.id,
          content: await this.fetchFullContent(i.id, scope, i.content_preview),
          salience: i.salience,
          sector: i.primary_sector as MemorySector | undefined,
          tags: i.tags,
          metadata: i.metadata,
          createdAt: i.last_seen_at ? new Date(i.last_seen_at).toISOString() : undefined,
        }))
      );

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
      await this.ready();
      const result = await this.callTool("openmemory_delete", {
        id: memoryId,
        ...this.scopeArgs(scope),
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

    // OpenMemory's MCP tools expose no dedicated profile endpoint, and the
    // only timestamp they return is last_seen_at — which is refreshed every
    // time a memory is read, including by this very call. Bucketing on it
    // into "long-standing" vs "recent" therefore collapses: after the first
    // session everything looks recent. Rather than fake that distinction we
    // return one ranked list of profile facts.
    const result = await this.searchMemories(query || "preferences style workflow", { userId: scope.userId }, {
      limit: CONFIG.maxProfileItems,
    });

    if (!result.success) {
      return { success: false, error: result.error };
    }

    const facts = result.results.slice(0, CONFIG.maxProfileItems).map((m) => m.content);

    return { success: true, profile: { static: facts, dynamic: [] } };
  }

  async close(): Promise<void> {
    const pid = this.pid;

    if (this.client) {
      log("McpMemoryClient: closing", { pid });
      // Tear the tree down *before* awaiting the graceful close. Once the
      // wrapper process exits, its children are reparented and can no longer
      // be found from this pid — so a graceful-first order would strand
      // exactly the processes we are trying to reap. OpenMemory's SQLite
      // store is crash-safe, so forcing this is the right trade against
      // leaking a server per session.
      if (pid !== null) killProcessTree(pid);
      await this.client.close().catch(() => {});
      this.client = null;
    }

    // onclose normally untracks the pid; drop it here too so a close that
    // never fires the event can't leave a stale entry behind that a later
    // exit handler would signal at a since-recycled pid.
    if (pid !== null) liveServerPids.delete(pid);
    this.pid = null;
  }
}

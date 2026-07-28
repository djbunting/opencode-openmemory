import { CONFIG, OPENMEMORY_API_URL, OPENMEMORY_API_KEY } from "../config.js";
import { log } from "./logger.js";
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
import { McpMemoryClient } from "./mcpClient.js";

const TIMEOUT_MS = 30000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    ),
  ]);
}

interface OpenMemoryQueryResponse {
  query: string;
  matches: Array<{
    id: string;
    content: string;
    score?: number;
    sectors?: string[];
    primary_sector?: string;
    path?: string;
    salience?: number;
    last_seen_at?: number;
  }>;
}

interface OpenMemoryAddResponse {
  id: string;
  root_memory_id?: string;
  primary_sector?: string;
}

interface OpenMemoryListResponse {
  items: Array<{
    id: string;
    content: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    created_at?: number;
    updated_at?: number;
    last_seen_at?: number;
    salience?: number;
    decay_lambda?: number;
    primary_sector?: string;
    version?: number;
    user_id?: string;
  }>;
}

/**
 * REST backend for a hosted/shared OpenMemory server.
 *
 * OpenMemory's REST API (v1.2+) derives tenant identity from the API key
 * itself (SHA-256 prefix of the key) and rejects any request whose
 * user_id doesn't match that tenant with 403 tenant_mismatch. That means
 * a single REST deployment + API key is ONE flat scope: there is no
 * server-side way to separate "user" memories from "project" memories
 * the way the MCP backend can (see mcpClient.ts). This client therefore
 * never sends user_id/project_id — every scope maps to the same tenant.
 *
 * If you need real user/project separation, use the MCP backend
 * (CONFIG.backend = "mcp", the default) which spawns a local OpenMemory
 * MCP server that still honors client-supplied user_id/project_id.
 */
export class OpenMemoryRESTClient implements IMemoryBackendClient {
  private baseUrl: string;
  private apiKey?: string;

  constructor() {
    this.baseUrl = OPENMEMORY_API_URL;
    this.apiKey = OPENMEMORY_API_KEY;
  }

  private async fetch(path: string, options: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    return withTimeout(
      fetch(`${this.baseUrl}${path}`, { ...options, headers }),
      TIMEOUT_MS
    );
  }

  async searchMemories(
    query: string,
    _scope: MemoryScopeContext,
    options?: { limit?: number; minSalience?: number; sector?: MemorySector }
  ): Promise<SearchMemoriesResult> {
    log("OpenMemoryREST.searchMemories", { query: query.slice(0, 50) });

    try {
      const response = await this.fetch("/memory/query", {
        method: "POST",
        body: JSON.stringify({
          query,
          k: options?.limit ?? CONFIG.maxMemories,
          filters: {
            ...(options?.minSalience !== undefined && { min_score: options.minSalience }),
            ...(options?.sector && { sector: options.sector }),
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, results: [], total: 0, error: `HTTP ${response.status}: ${errorText}` };
      }

      const data = await response.json() as OpenMemoryQueryResponse;
      const memories: MemoryItem[] = (data.matches || []).map((m) => ({
        id: m.id,
        content: m.content,
        score: m.score ?? m.salience ?? 1,
        salience: m.salience,
        sector: m.primary_sector as MemorySector | undefined,
      }));

      log("OpenMemoryREST.searchMemories: success", { count: memories.length });
      return { success: true, results: memories, total: memories.length };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("OpenMemoryREST.searchMemories: error", { error: errorMessage });
      return { success: false, results: [], total: 0, error: errorMessage };
    }
  }

  async addMemory(
    content: string,
    scope: MemoryScopeContext,
    options?: { type?: MemoryType; tags?: string[]; metadata?: Record<string, unknown> }
  ): Promise<AddMemoryResult> {
    log("OpenMemoryREST.addMemory", { contentLength: content.length });

    try {
      const response = await this.fetch("/memory/add", {
        method: "POST",
        body: JSON.stringify({
          content,
          tags: options?.tags,
          metadata: {
            ...options?.metadata,
            type: options?.type,
            scope: scope.projectId ? "project" : "user",
            source: "opencode-openmemory",
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, error: `HTTP ${response.status}: ${errorText}` };
      }

      const data = await response.json() as OpenMemoryAddResponse;
      log("OpenMemoryREST.addMemory: success", { id: data.id });
      return { success: true, id: data.id, sector: data.primary_sector as MemorySector | undefined };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("OpenMemoryREST.addMemory: error", { error: errorMessage });
      return { success: false, error: errorMessage };
    }
  }

  async listMemories(
    _scope: MemoryScopeContext,
    options?: { limit?: number; offset?: number; sector?: MemorySector }
  ): Promise<ListMemoriesResult> {
    log("OpenMemoryREST.listMemories", { limit: options?.limit });

    try {
      const params = new URLSearchParams({
        l: String(options?.limit ?? CONFIG.maxProjectMemories),
      });

      if (options?.offset !== undefined) {
        params.set("u", String(options.offset));
      }

      if (options?.sector) {
        params.set("sector", options.sector);
      }

      const response = await this.fetch(`/memory/all?${params}`);

      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, memories: [], error: `HTTP ${response.status}: ${errorText}` };
      }

      const data = await response.json() as OpenMemoryListResponse;
      const memories: MemoryItem[] = (data.items || []).map((m) => ({
        id: m.id,
        content: m.content,
        salience: m.salience,
        sector: m.primary_sector as MemorySector | undefined,
        tags: m.tags,
        metadata: m.metadata,
        createdAt: m.created_at ? new Date(m.created_at * 1000).toISOString() : undefined,
        updatedAt: m.updated_at ? new Date(m.updated_at * 1000).toISOString() : undefined,
      }));

      log("OpenMemoryREST.listMemories: success", { count: memories.length });
      return { success: true, memories, total: memories.length };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("OpenMemoryREST.listMemories: error", { error: errorMessage });
      return { success: false, memories: [], error: errorMessage };
    }
  }

  async deleteMemory(memoryId: string, _scope: MemoryScopeContext): Promise<DeleteMemoryResult> {
    log("OpenMemoryREST.deleteMemory", { memoryId });

    try {
      const response = await this.fetch(`/memory/${encodeURIComponent(memoryId)}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, error: `HTTP ${response.status}: ${errorText}` };
      }

      log("OpenMemoryREST.deleteMemory: success");
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("OpenMemoryREST.deleteMemory: error", { error: errorMessage });
      return { success: false, error: errorMessage };
    }
  }

  async reinforceMemory(memoryId: string, boost: number = 0.1): Promise<{ success: boolean; error?: string }> {
    log("OpenMemoryREST.reinforceMemory", { memoryId, boost });

    try {
      const response = await this.fetch("/memory/reinforce", {
        method: "POST",
        body: JSON.stringify({ id: memoryId, boost }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, error: `HTTP ${response.status}: ${errorText}` };
      }

      log("OpenMemoryREST.reinforceMemory: success");
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("OpenMemoryREST.reinforceMemory: error", { error: errorMessage });
      return { success: false, error: errorMessage };
    }
  }

  async getProfile(scope: MemoryScopeContext, query?: string): Promise<ProfileResult> {
    log("OpenMemoryREST.getProfile");

    try {
      const result = await this.searchMemories(query || "preferences style workflow", scope, {
        limit: CONFIG.maxProfileItems * 2,
      });

      if (!result.success) {
        return { success: false, error: result.error };
      }

      const now = Date.now();
      const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;

      const staticFacts = result.results
        .filter(m => m.createdAt && new Date(m.createdAt).getTime() < oneWeekAgo)
        .slice(0, CONFIG.maxProfileItems)
        .map(m => m.content);

      const dynamicFacts = result.results
        .filter(m => !m.createdAt || new Date(m.createdAt).getTime() >= oneWeekAgo)
        .slice(0, CONFIG.maxProfileItems)
        .map(m => m.content);

      log("OpenMemoryREST.getProfile: success", { staticCount: staticFacts.length, dynamicCount: dynamicFacts.length });
      return { success: true, profile: { static: staticFacts, dynamic: dynamicFacts } };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("OpenMemoryREST.getProfile: error", { error: errorMessage });
      return { success: false, error: errorMessage };
    }
  }
}

let clientInstance: IMemoryBackendClient | null = null;

export function getMemoryClient(): IMemoryBackendClient {
  if (!clientInstance) {
    clientInstance = CONFIG.backend === "rest" ? new OpenMemoryRESTClient() : new McpMemoryClient();
  }
  return clientInstance;
}

export async function closeMemoryClient(): Promise<void> {
  if (clientInstance?.close) {
    await clientInstance.close();
  }
  clientInstance = null;
}

export const openMemoryClient = {
  get client(): IMemoryBackendClient {
    return getMemoryClient();
  },

  searchMemories: (query: string, scope: MemoryScopeContext, options?: { limit?: number; minSalience?: number; sector?: MemorySector }) =>
    getMemoryClient().searchMemories(query, scope, options),

  addMemory: (content: string, scope: MemoryScopeContext, options?: { type?: MemoryType; tags?: string[]; metadata?: Record<string, unknown> }) =>
    getMemoryClient().addMemory(content, scope, options),

  listMemories: (scope: MemoryScopeContext, options?: { limit?: number; offset?: number; sector?: MemorySector }) =>
    getMemoryClient().listMemories(scope, options),

  deleteMemory: (memoryId: string, scope: MemoryScopeContext) =>
    getMemoryClient().deleteMemory(memoryId, scope),

  getProfile: (scope: MemoryScopeContext, query?: string) =>
    getMemoryClient().getProfile(scope, query),

  reinforceMemory: (memoryId: string, boost?: number) =>
    getMemoryClient().reinforceMemory?.(memoryId, boost) ?? Promise.resolve({ success: false, error: "Reinforce not supported by current backend" }),
};

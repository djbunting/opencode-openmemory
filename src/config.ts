import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { stripJsoncComments } from "./services/jsonc.js";

const CONFIG_DIR = join(homedir(), ".config", "opencode");
const CONFIG_FILES = [
  join(CONFIG_DIR, "openmemory.jsonc"),
  join(CONFIG_DIR, "openmemory.json"),
];

interface OpenMemoryConfig {
  // "mcp" (default): spawns a local OpenMemory MCP server over stdio.
  // Supports real user-vs-project memory scoping.
  // "rest": talks to a hosted/shared OpenMemory REST server. That API
  // derives tenant identity from the API key and has no concept of a
  // client-supplied scope, so REST mode has a single flat scope per key.
  backend?: "mcp" | "rest";

  // MCP backend settings (used when backend is "mcp").
  //
  // Set mcpUrl to talk to an already-running OpenMemory over its HTTP MCP
  // endpoint (e.g. "http://host:8800/mcp") instead of spawning a local
  // server. Remote servers derive user identity from the API key, but still
  // honour a client-supplied project_id, so project scoping keeps working.
  mcpUrl?: string;
  mcpHeaders?: Record<string, string>;

  // Used only when spawning a local server (i.e. when mcpUrl is unset).
  mcpCommand?: string;
  mcpArgs?: string[];
  // Extra env vars passed to the spawned MCP server process (e.g. for
  // embedding provider / database config), merged on top of the parent
  // process's environment.
  mcpEnv?: Record<string, string>;
  // Timeout (ms) for a single MCP tool call.
  mcpTimeout?: number;
  // Timeout (ms) for the initial spawn + handshake. Higher than
  // mcpTimeout because a cold `npx -y openmemory-js mcp` has to download
  // the package first (measured cold start: ~26s).
  mcpConnectTimeout?: number;

  // REST backend settings (used when backend is "rest")
  apiUrl?: string;
  apiKey?: string;

  maxMemories?: number;
  maxProjectMemories?: number;
  maxProfileItems?: number;
  minSalience?: number;

  injectProfile?: boolean;
  scopePrefix?: string;

  // Pins the identifier used for project-scoped memories, instead of deriving
  // one from OpenCode's project identity. Set this to share a scope with other
  // OpenMemory clients that already use a chosen name (e.g. "handheldlive").
  // Best set per project in <project>/.opencode/openmemory.jsonc.
  projectId?: string;
}

const DEFAULTS: Required<
  Omit<OpenMemoryConfig, "apiKey" | "mcpEnv" | "mcpUrl" | "mcpHeaders" | "projectId">
> = {
  backend: "mcp",
  mcpCommand: "npx",
  mcpArgs: ["-y", "openmemory-js", "mcp"],
  mcpTimeout: 30000,
  mcpConnectTimeout: 60000,
  apiUrl: "http://localhost:8080",
  maxMemories: 5,
  maxProjectMemories: 10,
  maxProfileItems: 5,
  minSalience: 0.3,
  injectProfile: true,
  scopePrefix: "opencode",
};

function readConfigFile(path: string): OpenMemoryConfig | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(stripJsoncComments(readFileSync(path, "utf-8"))) as OpenMemoryConfig;
  } catch {
    return null; // Invalid config, fall back to defaults
  }
}

function loadConfig(): OpenMemoryConfig {
  for (const path of CONFIG_FILES) {
    const config = readConfigFile(path);
    if (config) return config;
  }
  return {};
}

/**
 * Per-project overrides from `<directory>/.opencode/openmemory.jsonc`.
 *
 * Read at plugin init rather than module load, because the global config knows
 * nothing about which project a session belongs to. Only `projectId` is
 * meaningful here — everything else is a per-machine concern.
 */
export function loadProjectConfig(directory: string): { projectId?: string } {
  for (const name of ["openmemory.jsonc", "openmemory.json"]) {
    const config = readConfigFile(join(directory, ".opencode", name));
    if (config?.projectId) return { projectId: config.projectId };
  }
  return {};
}

const fileConfig = loadConfig();

export const OPENMEMORY_API_KEY = fileConfig.apiKey ?? process.env.OPENMEMORY_API_KEY;
export const OPENMEMORY_API_URL = fileConfig.apiUrl ?? process.env.OPENMEMORY_API_URL ?? DEFAULTS.apiUrl;

/**
 * Chooses a backend when the config doesn't name one.
 *
 * Configs written before `backend` existed have no such field, but a user who
 * set `apiUrl` or `apiKey` was unambiguously pointing at a REST server. If we
 * applied the plain "mcp" default to those, the plugin would silently swap
 * their real server for an empty local store and every existing memory would
 * appear to vanish — which is exactly what happened when the default changed.
 * An explicit `backend` always wins, so opting into MCP alongside leftover
 * REST settings still works.
 */
function resolveBackend(): "mcp" | "rest" {
  const explicit = fileConfig.backend ?? (process.env.OPENMEMORY_BACKEND as "mcp" | "rest" | undefined);
  if (explicit) return explicit;
  // An mcpUrl is an unambiguous request for the MCP backend, and must win over
  // the legacy inference below — a remote MCP endpoint is normally configured
  // alongside the apiUrl/apiKey of the very same server.
  if (fileConfig.mcpUrl || process.env.OPENMEMORY_MCP_URL) return "mcp";
  if (fileConfig.apiUrl || fileConfig.apiKey) return "rest";
  return DEFAULTS.backend;
}

/**
 * Auth headers for a remote MCP endpoint. Explicit `mcpHeaders` win; otherwise
 * an `apiKey` is promoted to a Bearer token, so pointing `mcpUrl` at a server
 * you already have REST credentials for needs no extra configuration.
 */
function resolveMcpHeaders(): Record<string, string> | undefined {
  if (fileConfig.mcpHeaders) return fileConfig.mcpHeaders;
  const key = fileConfig.apiKey ?? process.env.OPENMEMORY_API_KEY;
  return key ? { Authorization: `Bearer ${key}` } : undefined;
}

export const MCP_URL = fileConfig.mcpUrl ?? process.env.OPENMEMORY_MCP_URL;

export const CONFIG = {
  backend: resolveBackend(),
  mcpUrl: MCP_URL,
  mcpHeaders: resolveMcpHeaders(),
  mcpCommand: fileConfig.mcpCommand ?? DEFAULTS.mcpCommand,
  mcpArgs: fileConfig.mcpArgs ?? DEFAULTS.mcpArgs,
  mcpEnv: fileConfig.mcpEnv,
  mcpTimeout: fileConfig.mcpTimeout ?? DEFAULTS.mcpTimeout,
  mcpConnectTimeout: fileConfig.mcpConnectTimeout ?? DEFAULTS.mcpConnectTimeout,
  apiUrl: OPENMEMORY_API_URL,
  maxMemories: fileConfig.maxMemories ?? DEFAULTS.maxMemories,
  maxProjectMemories: fileConfig.maxProjectMemories ?? DEFAULTS.maxProjectMemories,
  maxProfileItems: fileConfig.maxProfileItems ?? DEFAULTS.maxProfileItems,
  minSalience: fileConfig.minSalience ?? DEFAULTS.minSalience,
  injectProfile: fileConfig.injectProfile ?? DEFAULTS.injectProfile,
  scopePrefix: fileConfig.scopePrefix ?? DEFAULTS.scopePrefix,
  projectId: fileConfig.projectId,
};

export function isConfigured(): boolean {
  // REST: OpenMemory's REST API (v1.2+) derives tenant identity from the
  // API key and rejects unauthenticated requests, so without a key there
  // is nothing we can usefully do. apiUrl always has a default, so the
  // key is the only discriminator.
  if (CONFIG.backend === "rest") {
    return Boolean(OPENMEMORY_API_KEY);
  }

  // MCP over HTTP: a reachable endpoint is the only requirement. Auth may
  // legitimately be absent for a server running without OM_API_KEY.
  if (CONFIG.mcpUrl) {
    return CONFIG.mcpUrl.trim().length > 0;
  }

  // MCP over stdio: all we need is something to spawn. mcpCommand defaults to
  // "npx", so this is effectively always true unless the user blanked it out.
  return CONFIG.mcpCommand.trim().length > 0;
}

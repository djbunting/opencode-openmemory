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

  // MCP backend settings (used when backend is "mcp")
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
}

const DEFAULTS: Required<Omit<OpenMemoryConfig, "apiKey" | "mcpEnv">> = {
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

function loadConfig(): OpenMemoryConfig {
  for (const path of CONFIG_FILES) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        const json = stripJsoncComments(content);
        return JSON.parse(json) as OpenMemoryConfig;
      } catch {
        // Invalid config, use defaults
      }
    }
  }
  return {};
}

const fileConfig = loadConfig();

export const OPENMEMORY_API_KEY = fileConfig.apiKey ?? process.env.OPENMEMORY_API_KEY;
export const OPENMEMORY_API_URL = fileConfig.apiUrl ?? process.env.OPENMEMORY_API_URL ?? DEFAULTS.apiUrl;

export const CONFIG = {
  backend: fileConfig.backend ?? (process.env.OPENMEMORY_BACKEND as "mcp" | "rest" | undefined) ?? DEFAULTS.backend,
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
};

export function isConfigured(): boolean {
  // REST: OpenMemory's REST API (v1.2+) derives tenant identity from the
  // API key and rejects unauthenticated requests, so without a key there
  // is nothing we can usefully do. apiUrl always has a default, so the
  // key is the only discriminator.
  if (CONFIG.backend === "rest") {
    return Boolean(OPENMEMORY_API_KEY);
  }

  // MCP: all we need is something to spawn. mcpCommand defaults to "npx",
  // so this is effectively always true unless the user blanked it out.
  return CONFIG.mcpCommand.trim().length > 0;
}

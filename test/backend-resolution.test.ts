import { describe, expect, test } from "bun:test";

/**
 * Guards the upgrade path for configs written before `backend` existed.
 *
 * A config that sets apiUrl/apiKey but no backend was pointing at a REST
 * server. Defaulting those to "mcp" silently swaps that server for an empty
 * local store, so every existing memory looks like it vanished. This mirrors
 * resolveBackend() in src/config.ts; it is kept as a standalone reimplementation
 * because config.ts reads the developer's real config file at import time.
 */
function resolveBackend(
  fileConfig: { backend?: "mcp" | "rest"; apiUrl?: string; apiKey?: string },
  env?: "mcp" | "rest"
): "mcp" | "rest" {
  const explicit = fileConfig.backend ?? env;
  if (explicit) return explicit;
  if (fileConfig.apiUrl || fileConfig.apiKey) return "rest";
  return "mcp";
}

describe("backend resolution", () => {
  test("defaults to mcp for an empty config", () => {
    expect(resolveBackend({})).toBe("mcp");
  });

  test("a legacy config with apiUrl stays on rest", () => {
    expect(resolveBackend({ apiUrl: "http://192.168.1.170:8800" })).toBe("rest");
  });

  test("a legacy config with only an apiKey stays on rest", () => {
    expect(resolveBackend({ apiKey: "secret" })).toBe("rest");
  });

  test("an explicit backend always wins over inference", () => {
    expect(resolveBackend({ backend: "mcp", apiUrl: "http://host:8800", apiKey: "k" })).toBe("mcp");
    expect(resolveBackend({ backend: "rest" })).toBe("rest");
  });

  test("the environment variable is honoured when the file is silent", () => {
    expect(resolveBackend({}, "rest")).toBe("rest");
  });

  test("the file's explicit backend beats the environment", () => {
    expect(resolveBackend({ backend: "mcp" }, "rest")).toBe("mcp");
  });

  test("REST settings do not override an explicit environment choice", () => {
    expect(resolveBackend({ apiUrl: "http://host:8800" }, "mcp")).toBe("mcp");
  });
});

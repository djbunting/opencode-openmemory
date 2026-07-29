import { describe, expect, test } from "bun:test";
import { identityArgsFor, scopeArgsFor } from "../src/services/mcpClient.js";
import { getScopeKey } from "../src/services/tags.js";
import type { MemoryScopeContext } from "../src/types/index.js";

const USER: MemoryScopeContext = { userId: "u1" };
const PROJECT: MemoryScopeContext = { userId: "u1", projectId: "p1" };
const OTHER: MemoryScopeContext = { userId: "u1", projectId: "p2" };

describe("scoping: project mode, server owns user_id (remote HTTP)", () => {
  const args = (s: MemoryScopeContext) => scopeArgsFor("project", true, s);

  test("never sends user_id — a remote server 403s on a supplied one", () => {
    expect(args(PROJECT)).not.toHaveProperty("user_id");
    expect(args(USER)).not.toHaveProperty("user_id");
  });

  test("project scope rides in project_id", () => {
    expect(args(PROJECT)).toEqual({ project_id: "p1" });
  });

  test("a scope with no project falls back to the global bucket", () => {
    expect(args(USER)).toEqual({ project_id: "system_global" });
  });

  test("different projects get different project_id", () => {
    expect(args(PROJECT).project_id).not.toBe(args(OTHER).project_id);
  });
});

describe("scoping: project mode, we own user_id (local stdio)", () => {
  const args = (s: MemoryScopeContext) => scopeArgsFor("project", false, s);

  test("sends the plain userId alongside project_id", () => {
    expect(args(PROJECT)).toEqual({ project_id: "p1", user_id: "u1" });
  });

  test("user scope keeps the plain userId and the global bucket", () => {
    expect(args(USER)).toEqual({ project_id: "system_global", user_id: "u1" });
  });

  test("user_id is not the compound key in project mode", () => {
    expect(args(PROJECT).user_id).not.toBe(getScopeKey(PROJECT));
  });
});

describe("scoping: compound mode (server predates project_id)", () => {
  const args = (s: MemoryScopeContext) => scopeArgsFor("compound", false, s);

  test("never sends project_id — the server would ignore it", () => {
    expect(args(PROJECT)).not.toHaveProperty("project_id");
  });

  test("folds the project into the compound user_id", () => {
    expect(args(PROJECT)).toEqual({ user_id: getScopeKey(PROJECT) });
  });

  test("keeps distinct projects isolated via distinct keys", () => {
    expect(args(PROJECT).user_id).not.toBe(args(OTHER).user_id);
  });

  test("user scope differs from project scope", () => {
    expect(args(USER).user_id).not.toBe(args(PROJECT).user_id);
  });
});

describe("scoping: compound mode against a tenant-owned server", () => {
  test("degrades to no identity at all rather than sending a rejected one", () => {
    // Nothing useful can be expressed here: the server pins user_id and
    // offers no project_id. Sending the compound key would be a 403.
    expect(scopeArgsFor("compound", true, PROJECT)).toEqual({});
  });
});

describe("identityArgsFor", () => {
  test("omits user_id entirely when the server owns it", () => {
    expect(identityArgsFor("project", true, PROJECT)).toEqual({});
    expect(identityArgsFor("compound", true, PROJECT)).toEqual({});
  });

  test("never includes project_id, even in project mode", () => {
    expect(identityArgsFor("project", false, PROJECT)).not.toHaveProperty("project_id");
  });

  test("uses the compound key only in compound mode", () => {
    expect(identityArgsFor("compound", false, PROJECT)).toEqual({ user_id: getScopeKey(PROJECT) });
    expect(identityArgsFor("project", false, PROJECT)).toEqual({ user_id: "u1" });
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProjectConfig } from "../src/config.js";
import { getProjectId, getProjectScopeId } from "../src/services/tags.js";

const roots: string[] = [];

function projectWith(contents: string | null, filename = "openmemory.jsonc"): string {
  const root = mkdtempSync(join(tmpdir(), "om-proj-"));
  roots.push(root);
  if (contents !== null) {
    mkdirSync(join(root, ".opencode"), { recursive: true });
    writeFileSync(join(root, ".opencode", filename), contents);
  }
  return root;
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("loadProjectConfig", () => {
  test("reads projectId from .opencode/openmemory.jsonc", () => {
    const root = projectWith(`{ /* pin scope */ "projectId": "handheldlive" }`);
    expect(loadProjectConfig(root)).toEqual({ projectId: "handheldlive" });
  });

  test("also accepts a .json filename", () => {
    const root = projectWith(`{"projectId":"plainjson"}`, "openmemory.json");
    expect(loadProjectConfig(root)).toEqual({ projectId: "plainjson" });
  });

  test("returns nothing when there is no project config", () => {
    expect(loadProjectConfig(projectWith(null))).toEqual({});
  });

  test("ignores a malformed config rather than throwing", () => {
    const root = projectWith("{ this is not json");
    expect(loadProjectConfig(root)).toEqual({});
  });

  test("ignores a config that sets no projectId", () => {
    expect(loadProjectConfig(projectWith(`{"maxMemories": 3}`))).toEqual({});
  });
});

describe("getProjectScopeId precedence", () => {
  test("a project override beats OpenCode's project id", () => {
    const root = projectWith(`{"projectId":"handheldlive"}`);
    expect(getProjectScopeId(root, { id: "opencode_generated_id" })).toBe("handheldlive");
  });

  test("the override is honoured via the worktree, not just the cwd", () => {
    const root = projectWith(`{"projectId":"handheldlive"}`);
    expect(getProjectScopeId("/some/subdir", { id: "x", worktree: root })).toBe("handheldlive");
  });

  test("falls back to OpenCode's project id with no override", () => {
    const root = projectWith(null);
    expect(getProjectScopeId(root, { id: "opencode_generated_id" })).toBe("opencode_generated_id");
  });

  test("falls back to a hashed worktree with neither override nor project id", () => {
    const root = projectWith(null);
    expect(getProjectScopeId(root)).toBe(getProjectId(root));
  });

  test("two projects pinned to the same name share one scope", () => {
    const a = projectWith(`{"projectId":"shared"}`);
    const b = projectWith(`{"projectId":"shared"}`);
    expect(getProjectScopeId(a, { id: "a" })).toBe(getProjectScopeId(b, { id: "b" }));
  });
});

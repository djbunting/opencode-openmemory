import { describe, expect, test } from "bun:test";
import {
  getProjectId,
  getProjectScopeId,
  getScopeKey,
  getScopes,
  getUserId,
  normalizePathForId,
} from "../src/services/tags.js";
import { CONFIG } from "../src/config.js";

const USER_A = "aaaaaaaaaaaaaaaa";
const USER_B = "bbbbbbbbbbbbbbbb";
const PROJ_1 = "1111111111111111";
const PROJ_2 = "2222222222222222";

describe("getScopeKey", () => {
  test("user scope is prefix:userId", () => {
    expect(getScopeKey({ userId: USER_A })).toBe(`${CONFIG.scopePrefix}:${USER_A}`);
  });

  test("project scope is prefix:userId:projectId", () => {
    expect(getScopeKey({ userId: USER_A, projectId: PROJ_1 })).toBe(
      `${CONFIG.scopePrefix}:${USER_A}:${PROJ_1}`
    );
  });

  test("user scope and project scope for the same user differ", () => {
    const userKey = getScopeKey({ userId: USER_A });
    const projectKey = getScopeKey({ userId: USER_A, projectId: PROJ_1 });
    expect(projectKey).not.toBe(userKey);
    // Project key must still be attributable to the user scope.
    expect(projectKey.startsWith(`${userKey}:`)).toBe(true);
  });

  test("two projects for the same user are isolated from each other", () => {
    const a = getScopeKey({ userId: USER_A, projectId: PROJ_1 });
    const b = getScopeKey({ userId: USER_A, projectId: PROJ_2 });
    expect(a).not.toBe(b);
  });

  test("the same project id under two users is isolated", () => {
    const a = getScopeKey({ userId: USER_A, projectId: PROJ_1 });
    const b = getScopeKey({ userId: USER_B, projectId: PROJ_1 });
    expect(a).not.toBe(b);
  });

  test("two users' user scopes are isolated", () => {
    expect(getScopeKey({ userId: USER_A })).not.toBe(getScopeKey({ userId: USER_B }));
  });

  test("is deterministic for identical input", () => {
    const scope = { userId: USER_A, projectId: PROJ_1 };
    expect(getScopeKey(scope)).toBe(getScopeKey(scope));
    expect(getScopeKey({ userId: USER_A, projectId: PROJ_1 })).toBe(
      getScopeKey({ userId: USER_A, projectId: PROJ_1 })
    );
  });

  test("an explicitly undefined projectId collapses to the user scope", () => {
    expect(getScopeKey({ userId: USER_A, projectId: undefined })).toBe(getScopeKey({ userId: USER_A }));
  });

  test("an empty-string projectId collapses to the user scope (falsy)", () => {
    // Documents current behaviour: "" is falsy, so it is treated as no project.
    expect(getScopeKey({ userId: USER_A, projectId: "" })).toBe(getScopeKey({ userId: USER_A }));
  });
});

describe("getProjectId", () => {
  test("returns 16 lowercase hex chars", () => {
    expect(getProjectId("/some/dir")).toMatch(/^[0-9a-f]{16}$/);
  });

  test("is deterministic", () => {
    expect(getProjectId("/some/dir")).toBe(getProjectId("/some/dir"));
  });

  test("differs for different directories", () => {
    expect(getProjectId("/some/dir")).not.toBe(getProjectId("/some/other-dir"));
  });

  test("ignores a trailing separator", () => {
    expect(getProjectId("/some/dir/")).toBe(getProjectId("/some/dir"));
  });

  test("treats forward and backward slashes as the same path", () => {
    // Regression guard: hashing the raw string gave `C:\p` and `C:/p`
    // different ids, silently splitting one project's memories in two.
    expect(getProjectId("C:\\temp\\proj")).toBe(getProjectId("C:/temp/proj"));
  });

  test("folds case only where the filesystem is case-insensitive", () => {
    const sameIgnoringCase = getProjectId("/Some/Dir") === getProjectId("/some/dir");
    // POSIX paths are case-sensitive, so /Some/Dir and /some/dir really are
    // different directories and must not collide.
    expect(sameIgnoringCase).toBe(process.platform === "win32");
  });
});

describe("normalizePathForId", () => {
  test("produces one canonical form for every spelling of a path", () => {
    const variants = ["C:\\temp\\proj", "C:/temp/proj", "C:\\temp\\proj\\", "C:/temp/proj/"];
    const normalized = new Set(variants.map(normalizePathForId));
    expect(normalized.size).toBe(1);
  });

  test("never leaves a trailing separator", () => {
    expect(normalizePathForId("/a/b/")).not.toMatch(/\/$/);
  });

  test("keeps distinct directories distinct", () => {
    expect(normalizePathForId("/a/b")).not.toBe(normalizePathForId("/a/c"));
  });
});

describe("getProjectScopeId", () => {
  test("prefers OpenCode's stable project id over any path", () => {
    expect(getProjectScopeId("/any/dir", { id: "proj_abc" })).toBe("proj_abc");
  });

  test("the same project id wins regardless of the directory given", () => {
    expect(getProjectScopeId("/dir/one", { id: "proj_abc" })).toBe(
      getProjectScopeId("/dir/two", { id: "proj_abc" })
    );
  });

  test("falls back to the worktree root when there is no project id", () => {
    expect(getProjectScopeId("/repo/packages/web", { worktree: "/repo" })).toBe(getProjectId("/repo"));
  });

  test("falls back to the directory when neither id nor worktree is given", () => {
    expect(getProjectScopeId("/repo")).toBe(getProjectId("/repo"));
  });
});

describe("getUserId", () => {
  test("returns 16 lowercase hex chars", () => {
    expect(getUserId()).toMatch(/^[0-9a-f]{16}$/);
  });

  test("is stable across calls in the same environment", () => {
    expect(getUserId()).toBe(getUserId());
  });
});

describe("getScopes", () => {
  test("shares one userId between the user and project scopes", () => {
    const { user, project } = getScopes("/some/dir");
    expect(project.userId).toBe(user.userId);
    expect(user.userId).toBe(getUserId());
  });

  test("only the project scope carries a projectId", () => {
    const { user, project } = getScopes("/some/dir");
    expect(user.projectId).toBeUndefined();
    expect(project.projectId).toBe(getProjectId("/some/dir"));
  });

  test("produces distinct scope keys per directory", () => {
    const a = getScopes("/repo/alpha");
    const b = getScopes("/repo/beta");
    expect(getScopeKey(a.project)).not.toBe(getScopeKey(b.project));
    // ...but the shared user scope stays the same across projects.
    expect(getScopeKey(a.user)).toBe(getScopeKey(b.user));
  });
});

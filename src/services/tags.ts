import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { CONFIG } from "../config.js";
import type { MemoryScopeContext } from "../types/index.js";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Canonicalises a filesystem path before it is hashed into an identifier.
 *
 * Hashing a raw path string is not safe: the same project reached as
 * `C:\proj`, `C:/proj`, `C:\proj\` and `c:\proj` produces four different
 * hashes, which silently splits a user's memories into disjoint scopes
 * that can never see each other. Normalise separators, drop any trailing
 * separator, and fold case only on Windows (where the filesystem is
 * case-insensitive); POSIX paths are case-sensitive so folding there
 * would wrongly merge genuinely distinct directories.
 */
export function normalizePathForId(directory: string): string {
  const absolute = resolve(directory).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

export function getGitEmail(): string | null {
  try {
    const email = execSync("git config user.email", { encoding: "utf-8" }).trim();
    return email || null;
  } catch {
    return null;
  }
}

export function getUserId(): string {
  const email = getGitEmail();
  if (email) {
    return sha256(email);
  }
  const fallback = process.env.USER || process.env.USERNAME || "anonymous";
  return sha256(fallback);
}

export function getProjectId(directory: string): string {
  return sha256(normalizePathForId(directory));
}

/**
 * Identity of the project a session belongs to.
 *
 * Prefers OpenCode's own `project.id`, which is stable across sessions and
 * independent of how the path was spelled or which subdirectory the session
 * was opened from. Falls back to hashing the worktree root (or the given
 * directory) when OpenCode doesn't supply one — e.g. older hosts or tests.
 */
export function getProjectScopeId(
  directory: string,
  project?: { id?: string; worktree?: string }
): string {
  if (project?.id) return project.id;
  return getProjectId(project?.worktree || directory);
}

export function getScopes(
  directory: string,
  project?: { id?: string; worktree?: string }
): { user: MemoryScopeContext; project: MemoryScopeContext } {
  const userId = getUserId();
  const projectId = getProjectScopeId(directory, project);

  return {
    user: { userId },
    project: { userId, projectId },
  };
}

/**
 * Collapses a scope into a single opaque identifier for backends whose
 * only isolation knob is a flat `user_id` string (e.g. the currently
 * published openmemory-js MCP tools, which predate native project_id
 * support). Project scope becomes userId+projectId so it stays isolated
 * both from other users and from that user's other projects.
 */
export function getScopeKey(scope: MemoryScopeContext): string {
  return scope.projectId
    ? `${CONFIG.scopePrefix}:${scope.userId}:${scope.projectId}`
    : `${CONFIG.scopePrefix}:${scope.userId}`;
}

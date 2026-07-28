import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { CONFIG } from "../config.js";
import type { MemoryScopeContext } from "../types/index.js";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
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
  return sha256(directory);
}

export function getScopes(directory: string): { user: MemoryScopeContext; project: MemoryScopeContext } {
  const userId = getUserId();
  const projectId = getProjectId(directory);
  
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

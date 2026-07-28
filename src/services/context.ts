import { CONFIG } from "../config.js";
import type { MemoryItem, ProfileResult } from "../types/index.js";

interface MemoriesResponseMinimal {
  results?: MemoryItem[];
  memories?: MemoryItem[];
}

// Renders one memory as `[sector][score%] content`, omitting whichever
// pieces are absent. Score/salience are compared against undefined rather
// than tested for truthiness so a genuine 0 still renders.
function formatMemoryLine(
  mem: MemoryItem,
  options?: { includeSector?: boolean }
): string {
  const segments: string[] = [];

  if (options?.includeSector && mem.sector) {
    segments.push(`[${mem.sector}]`);
  }

  if (mem.score !== undefined) {
    segments.push(`[${Math.round(mem.score * 100)}%]`);
  } else if (mem.salience !== undefined) {
    segments.push(`[sal:${Math.round(mem.salience * 100)}%]`);
  }

  const content = mem.content || "";
  return segments.length > 0 ? `${segments.join("")} ${content}` : content;
}

export function formatContextForPrompt(
  profile: ProfileResult | null,
  userMemories: MemoriesResponseMinimal,
  projectMemories: MemoriesResponseMinimal
): string {
  const parts: string[] = ["[OPENMEMORY]"];

  if (CONFIG.injectProfile && profile?.profile) {
    const { static: staticFacts, dynamic: dynamicFacts } = profile.profile;

    if (staticFacts.length > 0) {
      parts.push("\nUser Profile:");
      staticFacts.slice(0, CONFIG.maxProfileItems).forEach((fact) => {
        parts.push(`- ${fact}`);
      });
    }

    if (dynamicFacts.length > 0) {
      parts.push("\nRecent Context:");
      dynamicFacts.slice(0, CONFIG.maxProfileItems).forEach((fact) => {
        parts.push(`- ${fact}`);
      });
    }
  }

  // `??` rather than `||` to state the intent directly: a present-but-empty
  // `results` wins over `memories`. (Behaviour is identical either way here,
  // since `[]` is truthy — `??` just doesn't rely on that to be read.)
  const projectResults = projectMemories.results ?? projectMemories.memories ?? [];
  if (projectResults.length > 0) {
    parts.push("\nProject Knowledge:");
    projectResults.forEach((mem) => {
      parts.push(`- ${formatMemoryLine(mem)}`);
    });
  }

  const userResults = userMemories.results ?? userMemories.memories ?? [];
  if (userResults.length > 0) {
    parts.push("\nRelevant Memories:");
    userResults.forEach((mem) => {
      parts.push(`- ${formatMemoryLine(mem, { includeSector: true })}`);
    });
  }

  if (parts.length === 1) {
    return "";
  }

  return parts.join("\n");
}

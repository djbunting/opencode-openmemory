import { describe, expect, test } from "bun:test";
import { formatContextForPrompt } from "../src/services/context.js";
import { CONFIG } from "../src/config.js";
import type { MemoryItem, ProfileResult } from "../src/types/index.js";

// CONFIG is loaded from the developer's real ~/.config/opencode file, so
// every profile assertion below is written against CONFIG at runtime rather
// than against hard-coded defaults.
const { injectProfile, maxProfileItems } = CONFIG;

const EMPTY = {} as { results?: MemoryItem[]; memories?: MemoryItem[] };

function mem(partial: Partial<MemoryItem> & { content: string }): MemoryItem {
  return { id: partial.content, ...partial };
}

function profileOf(staticFacts: string[], dynamicFacts: string[]): ProfileResult {
  return { success: true, profile: { static: staticFacts, dynamic: dynamicFacts } };
}

describe("formatContextForPrompt - nothing to inject", () => {
  test("returns an empty string when all inputs are empty", () => {
    expect(formatContextForPrompt(null, EMPTY, EMPTY)).toBe("");
  });

  test("returns an empty string for empty arrays under either key", () => {
    expect(formatContextForPrompt(null, { results: [] }, { memories: [] })).toBe("");
    expect(formatContextForPrompt(null, { memories: [] }, { results: [] })).toBe("");
  });

  test("returns an empty string for a profile with no facts", () => {
    expect(formatContextForPrompt(profileOf([], []), EMPTY, EMPTY)).toBe("");
  });

  test("returns an empty string for a failed/absent profile payload", () => {
    expect(formatContextForPrompt({ success: false, error: "nope" }, EMPTY, EMPTY)).toBe("");
  });

  test("never emits a bare [OPENMEMORY] header", () => {
    const out = formatContextForPrompt(null, EMPTY, EMPTY);
    expect(out).not.toContain("[OPENMEMORY]");
  });
});

describe("formatContextForPrompt - memories", () => {
  test("emits the header once when there is something to inject", () => {
    const out = formatContextForPrompt(null, EMPTY, { results: [mem({ content: "uses bun" })] });
    expect(out.startsWith("[OPENMEMORY]")).toBe(true);
    expect(out.split("[OPENMEMORY]").length - 1).toBe(1);
  });

  test("project memories render under Project Knowledge", () => {
    const out = formatContextForPrompt(null, EMPTY, { results: [mem({ content: "uses bun" })] });
    expect(out).toContain("Project Knowledge:");
    expect(out).toContain("- uses bun");
    expect(out).not.toContain("Relevant Memories:");
  });

  test("user memories render under Relevant Memories", () => {
    const out = formatContextForPrompt(null, { results: [mem({ content: "prefers tabs" })] }, EMPTY);
    expect(out).toContain("Relevant Memories:");
    expect(out).toContain("prefers tabs");
    expect(out).not.toContain("Project Knowledge:");
  });

  test("accepts memories under the `memories` key as well as `results`", () => {
    const viaResults = formatContextForPrompt(null, { results: [mem({ content: "x" })] }, EMPTY);
    const viaMemories = formatContextForPrompt(null, { memories: [mem({ content: "x" })] }, EMPTY);
    expect(viaMemories).toBe(viaResults);

    const projResults = formatContextForPrompt(null, EMPTY, { results: [mem({ content: "y" })] });
    const projMemories = formatContextForPrompt(null, EMPTY, { memories: [mem({ content: "y" })] });
    expect(projMemories).toBe(projResults);
  });

  test("`results` wins over `memories` when both are present and non-empty", () => {
    const out = formatContextForPrompt(
      null,
      { results: [mem({ content: "from-results" })], memories: [mem({ content: "from-memories" })] },
      EMPTY
    );
    expect(out).toContain("from-results");
    expect(out).not.toContain("from-memories");
  });

  test("an empty `results` array does NOT fall back to `memories`", () => {
    // A present-but-empty `results` is an authoritative "no results",
    // not a signal to look at `memories` instead.
    const out = formatContextForPrompt(null, { results: [], memories: [mem({ content: "fallback" })] }, EMPTY);
    expect(out).toBe("");
  });

  test("a score of 0 renders as [0%] rather than being dropped", () => {
    const out = formatContextForPrompt(null, EMPTY, { results: [mem({ content: "zero", score: 0 })] });
    expect(out).toContain("[0%] zero");
  });

  test("a salience of 0 renders as [sal:0%] when no score is present", () => {
    const out = formatContextForPrompt(null, EMPTY, { results: [mem({ content: "zero", salience: 0 })] });
    expect(out).toContain("[sal:0%] zero");
  });

  test("a memory with no score, salience or sector has no stray whitespace", () => {
    const out = formatContextForPrompt(null, { results: [mem({ content: "bare" })] }, EMPTY);
    expect(out).toContain("- bare");
    expect(out).not.toContain("-  bare");
  });

  test("project section is emitted before the user section", () => {
    const out = formatContextForPrompt(
      null,
      { results: [mem({ content: "user-mem" })] },
      { results: [mem({ content: "project-mem" })] }
    );
    expect(out.indexOf("Project Knowledge:")).toBeLessThan(out.indexOf("Relevant Memories:"));
  });

  test("renders score as a rounded percentage", () => {
    const out = formatContextForPrompt(null, EMPTY, { results: [mem({ content: "c", score: 0.876 })] });
    expect(out).toContain("- [88%] c");
  });

  test("falls back to salience when there is no score", () => {
    const out = formatContextForPrompt(null, EMPTY, { results: [mem({ content: "c", salience: 0.42 })] });
    expect(out).toContain("- [sal:42%] c");
  });

  test("score takes precedence over salience", () => {
    const out = formatContextForPrompt(
      null,
      EMPTY,
      { results: [mem({ content: "c", score: 0.5, salience: 0.9 })] }
    );
    expect(out).toContain("- [50%] c");
    expect(out).not.toContain("sal:");
  });

  test("user memories include the sector label", () => {
    const out = formatContextForPrompt(
      null,
      { results: [mem({ content: "c", score: 0.9, sector: "semantic" })] },
      EMPTY
    );
    expect(out).toContain("[semantic][90%] c");
  });

  test("renders every memory it is given", () => {
    const items = ["a", "b", "c", "d"].map((c) => mem({ content: c }));
    const out = formatContextForPrompt(null, EMPTY, { results: items });
    for (const c of ["a", "b", "c", "d"]) expect(out).toContain(`- ${c}`);
  });

  test("tolerates a missing content field", () => {
    const out = formatContextForPrompt(null, EMPTY, {
      results: [{ id: "1" } as MemoryItem, mem({ content: "real" })],
    });
    expect(out).toContain("real");
    expect(out).toContain("Project Knowledge:");
  });
});

describe("formatContextForPrompt - profile", () => {
  test("static facts render under User Profile when profile injection is on", () => {
    const out = formatContextForPrompt(profileOf(["likes TypeScript"], []), EMPTY, EMPTY);
    if (injectProfile) {
      expect(out).toContain("User Profile:");
      expect(out).toContain("- likes TypeScript");
    } else {
      expect(out).toBe("");
    }
  });

  test("dynamic facts render under Recent Context when profile injection is on", () => {
    const out = formatContextForPrompt(profileOf([], ["migrating to bun"]), EMPTY, EMPTY);
    if (injectProfile) {
      expect(out).toContain("Recent Context:");
      expect(out).toContain("- migrating to bun");
      expect(out).not.toContain("User Profile:");
    } else {
      expect(out).toBe("");
    }
  });

  test("profile sections precede the memory sections", () => {
    const out = formatContextForPrompt(
      profileOf(["fact"], []),
      { results: [mem({ content: "user-mem" })] },
      { results: [mem({ content: "project-mem" })] }
    );
    if (injectProfile) {
      expect(out.indexOf("User Profile:")).toBeLessThan(out.indexOf("Project Knowledge:"));
    }
    expect(out).toContain("Project Knowledge:");
    expect(out).toContain("Relevant Memories:");
  });

  test("static facts are sliced to CONFIG.maxProfileItems", () => {
    const facts = Array.from({ length: maxProfileItems + 7 }, (_, i) => `static-fact-${i}`);
    const out = formatContextForPrompt(profileOf(facts, []), EMPTY, EMPTY);
    if (!injectProfile) {
      expect(out).toBe("");
      return;
    }
    const rendered = facts.filter((f) => out.includes(`- ${f}\n`) || out.endsWith(`- ${f}`));
    expect(rendered.length).toBe(maxProfileItems);
    // Keeps the first N, drops the tail.
    expect(out).toContain(`- ${facts[0]}`);
    expect(out).not.toContain(`- ${facts[facts.length - 1]}`);
  });

  test("dynamic facts are sliced to CONFIG.maxProfileItems", () => {
    const facts = Array.from({ length: maxProfileItems + 7 }, (_, i) => `dyn-fact-${i}`);
    const out = formatContextForPrompt(profileOf([], facts), EMPTY, EMPTY);
    if (!injectProfile) {
      expect(out).toBe("");
      return;
    }
    const rendered = facts.filter((f) => out.includes(`- ${f}\n`) || out.endsWith(`- ${f}`));
    expect(rendered.length).toBe(maxProfileItems);
  });

  test("a profile shorter than the cap is rendered in full", () => {
    const facts = Array.from({ length: Math.max(1, maxProfileItems - 1) }, (_, i) => `few-${i}`);
    const out = formatContextForPrompt(profileOf(facts, []), EMPTY, EMPTY);
    if (!injectProfile) {
      expect(out).toBe("");
      return;
    }
    for (const f of facts) expect(out).toContain(`- ${f}`);
  });
});

import { describe, expect, test } from "bun:test";
import { containsPrivateTag, isFullyPrivate, stripPrivateContent } from "../src/services/privacy.js";

describe("containsPrivateTag", () => {
  test("detects a simple private block", () => {
    expect(containsPrivateTag("hello <private>secret</private> world")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(containsPrivateTag("<PRIVATE>secret</PRIVATE>")).toBe(true);
    expect(containsPrivateTag("<Private>secret</Private>")).toBe(true);
  });

  test("matches across newlines", () => {
    expect(containsPrivateTag("<private>\nline one\nline two\n</private>")).toBe(true);
  });

  test("matches an empty private block", () => {
    expect(containsPrivateTag("<private></private>")).toBe(true);
  });

  test("returns false for plain content", () => {
    expect(containsPrivateTag("nothing to hide here")).toBe(false);
    expect(containsPrivateTag("")).toBe(false);
  });

  test("returns false for an unclosed tag", () => {
    expect(containsPrivateTag("<private>never closed")).toBe(false);
  });
});

describe("stripPrivateContent", () => {
  test("replaces a private block with [REDACTED]", () => {
    expect(stripPrivateContent("<private>secret</private>")).toBe("[REDACTED]");
  });

  test("keeps the surrounding public content", () => {
    expect(stripPrivateContent("before <private>secret</private> after")).toBe(
      "before [REDACTED] after"
    );
  });

  test("replaces every block, not just the first", () => {
    expect(stripPrivateContent("a <private>1</private> b <private>2</private> c")).toBe(
      "a [REDACTED] b [REDACTED] c"
    );
  });

  test("is non-greedy so two adjacent blocks are not merged", () => {
    const out = stripPrivateContent("<private>one</private>KEEP<private>two</private>");
    expect(out).toBe("[REDACTED]KEEP[REDACTED]");
    expect(out).toContain("KEEP");
  });

  test("strips multiline blocks and case variants", () => {
    expect(stripPrivateContent("x <PRIVATE>\nmy\nkey\n</private> y")).toBe("x [REDACTED] y");
  });

  test("leaves content without private tags untouched", () => {
    expect(stripPrivateContent("plain text")).toBe("plain text");
    expect(stripPrivateContent("")).toBe("");
  });

  test("does not leak the secret", () => {
    expect(stripPrivateContent("token <private>sk-abc123</private>")).not.toContain("sk-abc123");
  });
});

describe("isFullyPrivate", () => {
  test("true when the whole content is one private block", () => {
    expect(isFullyPrivate("<private>everything</private>")).toBe(true);
  });

  test("true when the private block is only surrounded by whitespace", () => {
    expect(isFullyPrivate("  \n <private>everything</private>\n  ")).toBe(true);
  });

  test("true for empty or whitespace-only content", () => {
    expect(isFullyPrivate("")).toBe(true);
    expect(isFullyPrivate("   \n\t ")).toBe(true);
  });

  test("false when public content survives alongside the private block", () => {
    expect(isFullyPrivate("keep this <private>secret</private>")).toBe(false);
    expect(isFullyPrivate("<private>secret</private> keep this")).toBe(false);
  });

  test("false for content with no private tags at all", () => {
    expect(isFullyPrivate("just a normal memory")).toBe(false);
  });

  test("false for multiple private blocks separated by public text", () => {
    expect(isFullyPrivate("<private>a</private> and <private>b</private>")).toBe(false);
  });

  test("true for adjacent private blocks with nothing between them", () => {
    expect(isFullyPrivate("<private>a</private><private>b</private>")).toBe(true);
  });

  test("true for many private blocks separated only by whitespace", () => {
    expect(isFullyPrivate("<private>a</private>\n <private>b</private>  <private>c</private>")).toBe(true);
  });
});

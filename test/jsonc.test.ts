import { describe, expect, test } from "bun:test";
import { stripJsoncComments } from "../src/services/jsonc.js";

describe("stripJsoncComments - line comments", () => {
  test("removes a whole-line // comment", () => {
    const out = stripJsoncComments('// leading note\n{"a":1}');
    expect(out.trim()).toBe('{"a":1}');
    expect(JSON.parse(out)).toEqual({ a: 1 });
  });

  test("removes a trailing // comment but keeps the newline", () => {
    const out = stripJsoncComments('{\n"a":1 // why\n}');
    expect(out).toBe('{\n"a":1 \n}');
    expect(JSON.parse(out)).toEqual({ a: 1 });
  });

  test("a // comment at EOF without a trailing newline is removed", () => {
    expect(stripJsoncComments('{"a":1}// end')).toBe('{"a":1}');
  });
});

describe("stripJsoncComments - block comments", () => {
  test("removes a single-line block comment", () => {
    const out = stripJsoncComments('{/* note */"a":1}');
    expect(out).toBe('{"a":1}');
  });

  test("removes a multi-line block comment but preserves its newlines", () => {
    const out = stripJsoncComments('{\n/* one\ntwo */\n"a":1\n}');
    expect(JSON.parse(out)).toEqual({ a: 1 });
    // Line count is preserved so error offsets stay roughly aligned.
    expect(out.split("\n").length).toBe(5);
  });

  test("handles several block comments in one document", () => {
    const out = stripJsoncComments('{/*x*/"a":1,/*y*/"b":2/*z*/}');
    expect(JSON.parse(out)).toEqual({ a: 1, b: 2 });
  });

  test("a // sequence inside a block comment does not leak", () => {
    expect(stripJsoncComments('{/* see http://example.com */"a":1}')).toBe('{"a":1}');
  });
});

describe("stripJsoncComments - comments inside string literals", () => {
  test("does not strip // inside a URL string (the classic bug)", () => {
    const src = '{"apiUrl": "http://localhost:8080"}';
    expect(stripJsoncComments(src)).toBe(src);
    expect(JSON.parse(stripJsoncComments(src))).toEqual({ apiUrl: "http://localhost:8080" });
  });

  test("does not strip /* */ inside a string", () => {
    const src = '{"glob": "/* not a comment */"}';
    expect(stripJsoncComments(src)).toBe(src);
    expect(JSON.parse(stripJsoncComments(src)).glob).toBe("/* not a comment */");
  });

  test("strips a real comment that follows a URL string on the same line", () => {
    const out = stripJsoncComments('{"apiUrl": "http://localhost:8080" // the server\n}');
    expect(JSON.parse(out)).toEqual({ apiUrl: "http://localhost:8080" });
  });

  test("keeps // inside a string even when a real comment appears earlier", () => {
    const out = stripJsoncComments('// header\n{"u":"https://a.example/b//c"}');
    expect(JSON.parse(out).u).toBe("https://a.example/b//c");
  });
});

describe("stripJsoncComments - escaped quotes and the backslash parity rule", () => {
  test("an escaped quote does not end the string", () => {
    const src = String.raw`{"q":"a \" b // still in string"}`;
    expect(stripJsoncComments(src)).toBe(src);
    expect(JSON.parse(stripJsoncComments(src)).q).toBe('a " b // still in string');
  });

  test("odd backslash count = escaped quote, string continues", () => {
    // "a\"" -> the inner quote is escaped, so the // stays inside the string.
    const src = String.raw`{"q":"a\"//x"}`;
    expect(stripJsoncComments(src)).toBe(src);
    expect(JSON.parse(stripJsoncComments(src)).q).toBe(String.raw`a"//x`);
  });

  test("even backslash count = the quote closes the string, so a following // is a comment", () => {
    // "a\\" -> escaped backslash then a real closing quote.
    const src = String.raw`{"q":"a\\"}//trailing`;
    const out = stripJsoncComments(src);
    expect(out).toBe(String.raw`{"q":"a\\"}`);
    expect(JSON.parse(out).q).toBe("a\\");
  });

  test("a Windows path ending in an escaped backslash still closes correctly", () => {
    const src = String.raw`{"dir":"C:\\tmp\\"} // trailing note`;
    const out = stripJsoncComments(src);
    expect(JSON.parse(out).dir).toBe("C:\\tmp\\");
    expect(out).not.toContain("trailing note");
  });

  test("three backslashes (odd) keep the string open", () => {
    const src = String.raw`{"q":"a\\\"b"}`;
    expect(stripJsoncComments(src)).toBe(src);
    expect(JSON.parse(stripJsoncComments(src)).q).toBe(String.raw`a\"b`);
  });
});

describe("stripJsoncComments - realistic config sample", () => {
  const sample = `{
  // Which backend to talk to.
  "backend": "mcp",

  /*
   * REST settings. Ignored when backend is "mcp".
   * See https://example.com/docs // deep link
   */
  "apiUrl": "http://localhost:8080", // default port
  "mcpCommand": "npx",
  "mcpArgs": ["-y", "openmemory-js", "mcp"], /* cold start ~26s */
  "maxMemories": 5,
  "injectProfile": true,
  "scopePrefix": "opencode"
}
`;

  test("output parses as valid JSON", () => {
    expect(() => JSON.parse(stripJsoncComments(sample))).not.toThrow();
  });

  test("all values survive intact", () => {
    expect(JSON.parse(stripJsoncComments(sample))).toEqual({
      backend: "mcp",
      apiUrl: "http://localhost:8080",
      mcpCommand: "npx",
      mcpArgs: ["-y", "openmemory-js", "mcp"],
      maxMemories: 5,
      injectProfile: true,
      scopePrefix: "opencode",
    });
  });

  test("no comment text remains", () => {
    const out = stripJsoncComments(sample);
    expect(out).not.toContain("Which backend");
    expect(out).not.toContain("default port");
    expect(out).not.toContain("cold start");
    expect(out).not.toContain("deep link");
  });
});

describe("stripJsoncComments - degenerate input", () => {
  test("empty input", () => {
    expect(stripJsoncComments("")).toBe("");
  });

  test("comment-only input", () => {
    expect(stripJsoncComments("// nothing here").trim()).toBe("");
  });

  test("plain JSON is returned byte-for-byte", () => {
    const src = '{"a":[1,2,3],"b":{"c":null},"d":"e"}';
    expect(stripJsoncComments(src)).toBe(src);
  });

  test("a lone forward slash in a string is preserved", () => {
    const src = '{"p":"a/b"}';
    expect(stripJsoncComments(src)).toBe(src);
  });
});

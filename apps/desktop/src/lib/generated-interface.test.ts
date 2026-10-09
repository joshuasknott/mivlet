import { describe, expect, it } from "vitest";
import {
  extractGeneratedInterface,
  validateGeneratedInterface,
} from "./generated-interface";
describe("bounded OpenUI profile", () => {
  it("accepts multiline literal tables and canonicalizes a sole display component", () => {
    const table = `reading = Table("Reading sessions", ["Session", "Notes"], [\n${Array.from({ length: 30 }, (_, i) => JSON.stringify([String(i + 1), 'A note with (brackets), a comma, and a "quote".'])).join(",\n")}\n])`;
    const result = validateGeneratedInterface(table);
    expect(result.error).toBeUndefined();
    expect(result.code).toMatch(/^root = Table/);
    expect(result.code).not.toContain("\n");
    expect(validateGeneratedInterface(`root = Stack([table])\ntable = ${table.slice(table.indexOf("Table"))}`).error).toBeUndefined();
    expect(validateGeneratedInterface('a = Text("one")\nb = Text("two")').error).toMatch(/root/);
    expect(validateGeneratedInterface('root = Table("T", ["C"], [\n["unfinished', true).code).toBe("");
  });
  it.each([
    'root = Table("T", ["C"], [\n[window.localStorage]\n])',
    'root = Text("a\nb")',
    'root = Text("safe")\nfetch("https://example.com")',
    'root = Table("T", ["C"], [\n["ok"]\n]); fetch("bad")',
  ])("rejects executable or malformed multiline input: %s", (code) => {
    expect(validateGeneratedInterface(code).error).toBeTruthy();
  });
  it("preserves exact provider source with Windows line endings and incomplete fences", () => {
    const code = 'root = Text("Hello")\r\n';
    expect(extractGeneratedInterface(`Before\r\n\`\`\`openui\r\n${code}\`\`\`\r\nAfter`)).toEqual({
      before: "Before\r\n", code, after: "\r\nAfter", complete: true,
    });
    expect(extractGeneratedInterface(`\`\`\`openui\r\n${code}`)).toEqual({
      before: "", code, after: "", complete: false,
    });
    expect(validateGeneratedInterface(code).error).toBeUndefined();
  });
  it("accepts progressive catalogue references and restores complete mixed responses", () => {
    const code =
      'root = Stack([choice])\nchoice = Options("route", "Direction", ["Simple", "Detailed"])';
    expect(validateGeneratedInterface(code).error).toBeUndefined();
    expect(
      validateGeneratedInterface(
        'root = Stack([choice])\nchoice = Options("route", "Dir',
        true,
      ).code,
    ).toBe("root = Stack([choice])");
    expect(validateGeneratedInterface("root = Stack([choice])").error).toMatch(
      /unresolved/,
    );
    expect(
      extractGeneratedInterface(`Intro\n\`\`\`openui\n${code}\n\`\`\`\nAfter`),
    ).toMatchObject({ before: "Intro\n", after: "\nAfter", complete: true });
  });
  it.each([
    'root = Query("read-file", {})',
    "root = Stack([root])",
    "root = Stack([a])\na = Stack([root])",
    "root = Text(window.localStorage)",
    'root = Text("safe"); fetch("https://example.com")',
    'root = Text({"__proto__":"unsafe"})',
    "root = Text(@Run(tool))",
    'root = Text("one")\nroot = Text("two")',
    'root = Stack([a])\na = Text("ok")\nevil = Mutation("send", {})',
  ])(
    "rejects executable or ambiguous input before calling OpenUI: %s",
    (code) => {
      expect(validateGeneratedInterface(code).error).toBeTruthy();
      expect(validateGeneratedInterface(code).code).toBe("");
    },
  );
  it("bounds malformed input, depth and expanded reference count", () => {
    expect(validateGeneratedInterface("x".repeat(48_001)).error).toBeTruthy();
    expect(
      validateGeneratedInterface(
        `root = Stack(${"[".repeat(20)}0${"]".repeat(20)})`,
      ).error,
    ).toBeTruthy();
    const recursiveFanout =
      Array.from(
        { length: 12 },
        (_, i) =>
          `${i ? `a${i}` : "root"} = Stack([${Array(8)
            .fill(`a${i + 1}`)
            .join(",")}])`,
      ).join("\n") + '\na12 = Text("x")';
    expect(validateGeneratedInterface(recursiveFanout).error).toMatch(
      /resource limit/,
    );
  });
});

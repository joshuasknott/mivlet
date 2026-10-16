// @vitest-environment node
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build, type Rollup } from "vite";
import { Lexer, Marked, getDefaults, marked } from "marked";
import { expect, it } from "vitest";

it("ships the Markdown tokenizer without the unused HTML renderer and preserves tokens", async () => {
  const entry = "virtual:markdown-tokenizer";
  const installed = createRequire(import.meta.url).resolve("marked").replaceAll("\\", "/");
  const result = await build({
    configFile: false,
    logLevel: "silent",
    plugins: [{
      name: "tokenizer-fixture",
      resolveId: (id) => id === entry ? id : undefined,
      load: (id) => id === entry ? `export { Lexer } from ${JSON.stringify(installed)};` : undefined,
    }],
    build: {
      write: false,
      minify: "terser",
      rollupOptions: { input: entry, preserveEntrySignatures: "strict", output: { format: "cjs" } },
    },
  }) as Rollup.RollupOutput;
  const chunk = result.output.find((output) => output.type === "chunk")!;
  expect(chunk.code).not.toContain("textRenderer");
  const exports = {} as { Lexer: typeof Lexer };
  runInNewContext(chunk.code, { exports });
  for (const markdown of [
    "# Heading\n\n**Bold**, *italic*, ~~deleted~~, `code` and [link](https://example.com).",
    "> Quote\n\n- [x] Done\n- [ ] Next\n\n```js\nconst x = 1;\n```",
    "| A | B |\n| - | - |\n| 1 | 2 |\n\n![alt](image.png)\n\n<div>raw HTML</div>",
    "[ref][id]\n\n[id]: https://example.com 'Title'\n\nEscaped \\* and &amp; text.",
  ]) {
    expect(JSON.stringify(exports.Lexer.lex(markdown, { gfm: true })))
      .toBe(JSON.stringify(Lexer.lex(markdown, { gfm: true })));
  }
});

it("preserves Marked's public singleton and independent instance APIs", () => {
  try {
    marked.setOptions({ breaks: true });
    expect(marked.parse("one\ntwo")).toContain("<br>");
    expect(marked.parseInline("**bold**")).toBe("<strong>bold</strong>");
    const instance = new Marked({ renderer: { heading: ({ text }) => `<h2>${text}</h2>` } });
    expect(instance.parse("# Title")).toBe("<h2>Title</h2>");
    expect(marked.parse("# Title")).toContain("<h1>Title</h1>");
    const visited: string[] = [];
    marked.walkTokens(marked.lexer("**bold**"), (token) => { visited.push(token.type); });
    expect(visited).toContain("strong");
    expect(marked.Parser).toBeDefined();
    expect(marked.Lexer).toBe(Lexer);
  } finally {
    marked.setOptions(getDefaults());
  }
});

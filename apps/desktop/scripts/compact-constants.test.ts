// @vitest-environment node
import { gzipSync } from "node:zlib";
import { runInNewContext } from "node:vm";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, unlink, writeFile, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { build, type Rollup } from "vite";
import { expect, it } from "vitest";
import {
  compactConstants,
  compactModule,
  hasStaticCycle,
  shareEmittedConstants,
} from "./compact-constants";
import { normalizeEmittedCode } from "./minify-workspace";

const repeated = Array.from(
  { length: 80 },
  (_, index) => `
  { workspaceGeneration: ${index}, approvalRequestIdentifier: "single-use-request", className: "control-row", children: "Complete request" }
`,
).join(",");
const fixture = `
  const $ = "existing binding";
  const rows = [${repeated}];
  let reads = 0;
  const owner = { get workspaceGeneration() { reads++; return 12; } };
  class PrivateState { #workspaceGeneration = 7; read() { return this.#workspaceGeneration; } }
  const prototype = { originalPrototype: true };
  const record = { __proto__: prototype, ["__proto__"]: "own-data" };
  const fields = Object.keys(rows[0]);
  const { "approvalRequestIdentifier": destructured } = rows[0];
  const actual = rows.map(row => [row.workspaceGeneration, row.approvalRequestIdentifier, row.className, row.children]);
  const missing = null;
  function reply(){return"single-use-request"}
  function choose(value){switch(value){case"single-use-request":return"Complete request";default:return"control-row"}}
  function contains(){return"workspaceGeneration"in rows[0]}
  function fail(){throw"single-use-request"}
  function* sequence(){yield"single-use-request"}
  let thrown; try { fail(); } catch(value) { thrown = value; }
  globalThis.result = JSON.stringify({
    actual, fields, destructured, existing: $, privateValue: new PrivateState().read(),
    optional: missing?.workspaceGeneration ?? "absent",
    generation: owner?.workspaceGeneration, reads,
    prototypePreserved: Object.getPrototypeOf(record) === prototype,
    ownProto: Object.hasOwn(record, "__proto__"), protoValue: record.__proto__,
    reply: reply(), chosen: choose(reply()), contains: contains(), thrown, yielded: sequence().next().value
  });
`;

it.each([compactConstants, compactModule])(
  "reduces both encodings while preserving native wire keys, DOM props, order, getters, private fields and prototypes (%#)",
  (optimize) => {
    const compact = optimize(fixture);
    const before: { result?: string } = {};
    const after: { result?: string } = {};
    runInNewContext('"use strict";' + fixture, before);
    runInNewContext('"use strict";' + compact, after);
    expect(after.result).toBe(before.result);
    expect(Buffer.byteLength(compact)).toBeLessThan(Buffer.byteLength(fixture));
    expect(gzipSync(compact).byteLength).toBeLessThanOrEqual(
      gzipSync(fixture).byteLength,
    );
  },
);

it("preserves module addresses, string export names, directives and tagged template raw text", () => {
  const source = `
    "use strict";
    import { "approvalRequestIdentifier" as input } from "./single-use-request.js";
    export { input as "approvalRequestIdentifier" };
    export const rows = [${repeated}];
    export const load = () => import("./single-use-request.js");
    export const raw = String.raw\`single-use-request\\n\`;
  `;
  const compact = compactConstants(source);
  expect(compact).toContain('from "./single-use-request.js"');
  expect(compact).toContain('import("./single-use-request.js")');
  expect(compact).toContain('as "approvalRequestIdentifier"');
  expect(compact).toContain('"use strict"');
  expect(compact).toContain("String.raw`single-use-request\\n`");
  const parsed = ts.createSourceFile(
    "result.js",
    compact,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  expect(
    (parsed as ts.SourceFile & { parseDiagnostics: readonly unknown[] })
      .parseDiagnostics,
  ).toEqual([]);
});

it("leaves direct eval and code without a measured benefit unchanged", () => {
  const opaque = `${fixture}; eval("rows[0].workspaceGeneration");`;
  expect(compactConstants(opaque)).toBe(opaque);
  expect(compactConstants(`${fixture}; (eval)("rows");`)).toBe(
    `${fixture}; (eval)("rows");`,
  );
  expect(compactConstants("export const value = 1;")).toBe(
    "export const value = 1;",
  );
});

it("refuses constant sharing for static cycle participants, including self imports", () => {
  const chunks = {
    a: { imports: ["b"] },
    b: { imports: ["a"] },
    caller: { imports: ["a"] },
    self: { imports: ["self"] },
    leaf: { imports: ["external"] },
  };
  expect(hasStaticCycle("a", chunks)).toBe(true);
  expect(hasStaticCycle("b", chunks)).toBe(true);
  expect(hasStaticCycle("self", chunks)).toBe(true);
  expect(hasStaticCycle("caller", chunks)).toBe(false);
  expect(hasStaticCycle("leaf", chunks)).toBe(false);
});

it("executes an early cross-module call through a real minified ESM cycle", async () => {
  const fixture = await realpath(
    await mkdtemp(join(tmpdir(), "mivlet-constant-cycle-")),
  );
  const written: string[] = [];
  try {
    const modules: Record<string, string> = {
      "fixture:a": `import { duringInitialization } from "fixture:b";
        export function read() { return [${repeated}]; }
        console.log(JSON.stringify(duringInitialization));`,
      "fixture:b": `import { read } from "fixture:a";
        export const duringInitialization = read()[0];`,
    };
    const result = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [
        normalizeEmittedCode(),
        shareEmittedConstants(),
        {
          name: "constant-cycle-fixture",
          resolveId: (id) => (id in modules ? id : undefined),
          load: (id) => modules[id],
        },
      ],
      build: {
        write: false,
        minify: "terser",
        rollupOptions: {
          input: { a: "fixture:a", b: "fixture:b" },
          preserveEntrySignatures: "strict",
          output: {
            entryFileNames: "[name].mjs",
            chunkFileNames: "[name].mjs",
            manualChunks: { a: ["fixture:a"], b: ["fixture:b"] },
            onlyExplicitManualChunks: true,
          },
        },
      },
    })) as Rollup.RollupOutput;
    const chunks = result.output.filter((item) => item.type === "chunk");
    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      const file = join(fixture, chunk.fileName);
      await writeFile(file, chunk.code);
      written.push(file);
    }
    expect(
      JSON.parse(
        execFileSync(process.execPath, [join(fixture, "a.mjs")], {
          encoding: "utf8",
        }),
      ),
    ).toEqual({
      workspaceGeneration: 0,
      approvalRequestIdentifier: "single-use-request",
      className: "control-row",
      children: "Complete request",
    });
  } finally {
    // Remove only the exact generated files and the empty directory we created.
    await Promise.all(written.map((file) => unlink(file)));
    await rmdir(fixture);
  }
}, 30_000);

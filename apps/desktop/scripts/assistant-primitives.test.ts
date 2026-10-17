// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { build, type Rollup } from "vite";
import { expect, it } from "vitest";
import {
  treeShakeAssistantEntry,
  treeShakeAssistantPrimitives,
} from "./assistant-primitives";

const installed = createRequire(import.meta.url)
  .resolve("@assistant-ui/react")
  .replaceAll("\\", "/");

it("rejects package entry changes instead of silently retaining an unreviewed transformation", () => {
  const code = readFileSync(installed, "utf8");
  expect(() => treeShakeAssistantEntry(code)).not.toThrow();
  expect(() =>
    treeShakeAssistantEntry(code.replace("thread_exports", "changed_exports")),
  ).toThrow(/entry changed/);
});

it("retains used assistant primitives while removing unused rendering and viewport implementations", async () => {
  const entry = "virtual:assistant-controls";
  const result = (await build({
    configFile: false,
    logLevel: "silent",
    plugins: [
      treeShakeAssistantPrimitives(),
      {
        name: "assistant-controls-fixture",
        resolveId: (id) => (id === entry ? id : undefined),
        load: (id) =>
          id === entry
            ? `import { ThreadPrimitive, MessagePrimitive, ComposerPrimitive, ActionBarPrimitive } from ${JSON.stringify(installed)};
        export const controls = [ThreadPrimitive.Root, ThreadPrimitive.Unstable_MessageById, MessagePrimitive.Root, ComposerPrimitive.Root, ComposerPrimitive.Input, ComposerPrimitive.Cancel, ComposerPrimitive.Send, ActionBarPrimitive.Root, ActionBarPrimitive.Copy, ActionBarPrimitive.Edit, ActionBarPrimitive.Reload];`
            : undefined,
      },
    ],
    build: {
      write: false,
      minify: false,
      rollupOptions: { input: entry, preserveEntrySignatures: "strict" },
    },
  })) as Rollup.RollupOutput;
  const modules = result.output
    .flatMap((item) => (item.type === "chunk" ? Object.keys(item.modules) : []))
    .join("\n");
  for (const used of [
    "ThreadRoot",
    "ThreadMessages",
    "MessageRoot",
    "ComposerInput",
    "ComposerSend",
    "ActionBarCopy",
    "ActionBarEdit",
    "ActionBarReload",
  ])
    expect(modules).toContain(`/${used}.js`);
  for (const unused of [
    "MessageParts",
    "MessagePartsGrouped",
    "ThreadViewport",
    "ThreadScrollToBottom",
    "ComposerDictate",
    "ActionBarSpeak",
  ])
    expect(modules).not.toContain(`/${unused}.js`);
  // This builds the installed dependency graph, including cold Windows I/O.
  // Runtime performance is guarded separately; retain every graph assertion.
}, 30_000);

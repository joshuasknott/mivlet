// @vitest-environment node
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "vite";
import { expect, it } from "vitest";

it("production omits synthetic stores and rejects storage without the desktop bridge", async () => {
  const entry = "virtual:preview-store-boundary";
  const result = await build({
    configFile: false, logLevel: "silent", mode: "production",
    define: { "import.meta.env.DEV": "false", "import.meta.env.MODE": JSON.stringify("production") },
    plugins: [{ name: "fixture-entry", resolveId(id) { if (id === entry) return id; },
      load(id) { if (id === entry) return [
        'export * from ' + JSON.stringify(resolve("src/runtime/domains/conversations.ts")) + ';',
        'export * from ' + JSON.stringify(resolve("src/runtime/domains/outputs.ts")) + ';',
        'export { setActiveRuntimeDataScope } from ' + JSON.stringify(resolve("src/runtime-scope.ts")) + ';',
      ].join("\n"); },
    }],
    build: { write: false, minify: false,
      rollupOptions: { input: entry, preserveEntrySignatures: "strict", output: { format: "cjs", inlineDynamicImports: true } },
    },
  });
  if (Array.isArray(result) || !("output" in result)) throw new Error("Expected one build.");
  const chunk = result.output.find(item => item.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("Missing compiled fixture.");
  for (const marker of ["thread-preview-", "preview-user", "previewConversationStores", "previewOutputs"])
    expect(chunk.code).not.toContain(marker);
  const exports: Record<string, (...args: unknown[]) => unknown> = {};
  // These runtime values cannot re-enable compile-time fixture branches.
  runInNewContext(chunk.code, { exports, globalThis: { DEV: true, MODE: "test" },
    localStorage: { getItem: () => '{"connectedBackendIds":["openai"]}' } });
  exports.setActiveRuntimeDataScope("workspace-a");
  await expect(exports.listRuntimeConversationThreads()).rejects.toThrow("requires the installed Mivlet desktop app");
  await expect(exports.saveRuntimeConversationDraft({ draftKey: "new-thread", content: "draft", updatedAt: "now" }))
    .rejects.toThrow("requires the installed Mivlet desktop app");
  await expect(exports.listRuntimeOutputs()).rejects.toThrow("requires the installed Mivlet desktop app");
  await expect(exports.ensureRuntimeOutput({ id: "report", content: "content" }))
    .rejects.toThrow("requires the installed Mivlet desktop app");
}, 20_000);

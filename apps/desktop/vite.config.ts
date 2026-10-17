import { fileURLToPath, URL } from "node:url";
import { realpathSync } from "node:fs";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { pruneUnusedIconWeights } from "./scripts/icon-weights";
import { compactStyleNames } from "./scripts/compact-style-names";
import { treeShakeAssistantPrimitives } from "./scripts/assistant-primitives";
import { assistantInputDependency, commonRouteChunk } from "./scripts/common-route-chunks";

export default defineConfig({
  plugins: [
    treeShakeAssistantPrimitives(),
    compactStyleNames(fileURLToPath(new URL("./src", import.meta.url))),
    react(),
    pruneUnusedIconWeights([
      fileURLToPath(new URL("./src", import.meta.url)),
      fileURLToPath(new URL("../../packages", import.meta.url)),
    ]),
  ],
  resolve: {
    alias: [
      {
        find: /^@mivlet\/connectors\/(.+)$/,
        replacement: `${fileURLToPath(new URL("../../packages/connectors/src", import.meta.url))}/$1`,
      },
      {
        find: "@mivlet/protocol",
        replacement: fileURLToPath(
          new URL("../../packages/protocol/src/index.ts", import.meta.url),
        ),
      },
      {
        find: "@mivlet/connectors",
        replacement: fileURLToPath(
          new URL("../../packages/connectors/src/index.ts", import.meta.url),
        ),
      },
      {
        find: "@mivlet/knowledge",
        replacement: fileURLToPath(
          new URL("../../packages/knowledge/src/index.ts", import.meta.url),
        ),
      },
    ],
  },
  clearScreen: false, // Prompt generation uses a separate dependency cache.
  server: {
    port: 1420,
    strictPort: true,
    // Worktrees can share a pnpm dependency directory through a junction.
    // Permit its resolved assets without exposing the surrounding checkout.
    fs: {
      allow: [
        fileURLToPath(new URL("../../", import.meta.url)),
        realpathSync(fileURLToPath(new URL("../../node_modules", import.meta.url))),
      ],
    },
    watch: {
      ignored: ["**/src-tauri/target/**"],
    },
  },
  // The desktop shell ships to a modern WebView2 (Chromium) runtime, so the
  // production build can target modern syntax without down-leveling. A shared
  // vendor chunk keeps one React instance and avoids a circular dependency
  // between React and packages that import React. A shared icon wrapper and
  // cached SVG artwork avoid repeated glyph allocations while retaining the
  // library's presentation contract.
  build: {
    manifest: true,
    target: "esnext",
    // Keep the expanded connector flow inside the existing download budgets.
    minify: "terser",
    cssMinify: "lightningcss",
    // Keep conversation-only styles beside the lazy ConversationPane graph so
    // the shell's base stylesheet remains covered by its existing ceiling.
    cssCodeSplit: true,
    terserOptions: { maxWorkers: 2, ecma: 2020, compress: { passes: 3 } },
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        onlyExplicitManualChunks: true,
        manualChunks(id, { getModuleInfo }) {
          const route = commonRouteChunk(id);
          if (route) return route;
          // These small session controls share one deferred conversation island.
          // Opening a session no longer fetches four mutually importing chunks.
          if (/[/\\]components[/\\]conversation[/\\]coding[/\\]/.test(id))
            return "ConversationPane-sessions";
          // The PDF engine is loaded only when a verified PDF preview opens.
          if (/[/\\]node_modules[/\\]pdfjs-dist[/\\]/.test(id))
            return "pdf-renderer";
          // Entry already loads these common modules with React. Sharing the
          // vendor request removes repeated imports without an eager graph change.
          if (id.includes("@phosphor-icons") || id === "\0mivlet-icon-wrapper"
            || id === "\0commonjsHelpers.js") return "vendor";
          // Conversation-only UI engines are reached through the lazy
          // ConversationPane boundary. Keeping their package graphs in
          // dedicated chunks prevents the shell's generic vendor chunk from
          // eagerly pulling OpenUI, assistant-ui, or MCP App code at startup.
          if (id.includes("vite/preload-helper")) return "feature-preload";
          if (id.includes("@assistant-ui") || /[/\\]assistant-stream[/\\]/.test(id)
            || assistantInputDependency(id, getModuleInfo)) return "assistant-ui";
          // Zod is used only by the generated-interface catalogues and their
          // OpenUI runtime. Do not pull its schema engine into eager vendor.
          if (/[/\\]zod[/\\]/.test(id)) return "interface-schema";
          if (id.includes("@openuidev")) return "intelligent-ui-runtime";
          if (
            /[/\\]node_modules[/\\](?:\.pnpm[/\\])?(?:@radix-ui|radix-ui|@floating-ui|d3-|internmap|lucide-react)/.test(
              id,
            )
          )
            return "intelligent-ui-widgets";
          if (id.includes("@modelcontextprotocol")) return "mcp-apps";
          if (/[/\\]node_modules[/\\]marked[/\\]/.test(id))
            return "conversation-markdown";
          if (id.includes("node_modules")) {
            return "vendor";
          }
          return undefined;
        },
      },
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  test: {
    // Native build/profile directories can contain downloaded provider tests.
    // They are runtime data, never part of the renderer's test suite.
    exclude: [...configDefaults.exclude, "src-tauri/**"],
    server: { deps: { inline: ["@openuidev/react-ui"] } },
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
  },
});

import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { pruneUnusedIconWeights } from "./scripts/icon-weights";
import { compactStyleNames } from "./scripts/compact-style-names";

export default defineConfig({
  plugins: [
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
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
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
        manualChunks(id) {
          // The PDF engine is loaded only when a verified PDF preview opens.
          if (/[/\\]node_modules[/\\]pdfjs-dist[/\\]/.test(id)) return "pdf-renderer";
          if (id.includes("@phosphor-icons")) return "icons";
          // Conversation-only UI engines are reached through the lazy
          // ConversationPane boundary. Keeping their package graphs in
          // dedicated chunks prevents the shell's generic vendor chunk from
          // eagerly pulling OpenUI, assistant-ui, or MCP App code at startup.
          if (id.includes("vite/preload-helper")) return "feature-preload";
          if (id.includes("@assistant-ui")) return "assistant-ui";
          if (id.includes("@openuidev")) return "openui";
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
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
  },
});

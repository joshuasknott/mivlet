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
  // production build can target modern syntax without down-leveling. Splitting
  // stable React vendor code into its own chunk keeps it cacheable across app
  // changes. A shared icon wrapper and cached SVG artwork avoid repeated
  // glyph allocations while retaining the library's presentation contract.
  build: {
    target: "esnext",
    // Keep the expanded connector flow inside the existing download budgets.
    minify: "terser",
    cssMinify: "lightningcss",
    cssCodeSplit: false,
    terserOptions: { maxWorkers: 2, ecma: 2020, compress: { passes: 3 } },
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@phosphor-icons")) return "icons";
          if (id.includes("node_modules")) {
            if (
              id.includes("@tanstack/react-query") ||
              id.includes("react-dom") ||
              id.includes("react-is") ||
              id.includes("scheduler") ||
              id.includes("use-sync-external-store") ||
              /[/\\]node_modules[/\\]react[/\\]/.test(id)
            ) {
              return "react-vendor";
            }
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

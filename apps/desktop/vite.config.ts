import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@fable/protocol": fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url)),
      "@fable/connectors": fileURLToPath(new URL("../../packages/connectors/src/index.ts", import.meta.url))
    }
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/target/**"]
    }
  },
  // The desktop shell ships to a modern WebView2 (Chromium) runtime, so the
  // production build can target modern syntax without down-leveling. Splitting
  // stable vendor code (react, react-dom, phosphor icons) into its own chunk
  // keeps it cacheable across app changes and pairs with the route-level
  // React.lazy splits to bring the initial workspace chunk well under the
  // 500 kB warning.
  build: {
    target: "esnext",
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("@phosphor-icons")) return "icons";
            if (id.includes("react-dom") || id.includes("/react/")) return "react-vendor";
            return "vendor";
          }
          return undefined;
        }
      }
    }
  },
  envPrefix: ["VITE_", "TAURI_"],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts"
  }
});

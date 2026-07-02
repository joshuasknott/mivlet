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
  // stable React vendor code into its own chunk keeps it cacheable across app
  // changes. Icons are left to Rollup's route-level chunking so route-only icon
  // modules do not ride along with the initial shell.
  build: {
    target: "esnext",
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@phosphor-icons")) return undefined;
          if (id.includes("node_modules")) {
            if (id.includes("react-dom") || /[/\\]node_modules[/\\]react[/\\]/.test(id)) {
              return "react-vendor";
            }
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

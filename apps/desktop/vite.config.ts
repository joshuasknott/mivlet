import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@arden/protocol": fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url)),
      "@arden/connectors": fileURLToPath(new URL("../../packages/connectors/src/index.ts", import.meta.url))
    }
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: false
  },
  envPrefix: ["VITE_", "TAURI_"],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts"
  }
});

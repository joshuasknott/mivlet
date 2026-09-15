import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./src/testing/cloudflare-workers-shim.ts", import.meta.url)),
      "@cloudflare/sandbox": fileURLToPath(new URL("./src/testing/cloudflare-sandbox-shim.ts", import.meta.url)),
      "@cloudflare/playwright": fileURLToPath(new URL("./src/testing/cloudflare-playwright-shim.ts", import.meta.url))
    }
  },
  test: {
    include: ["src/**/*.test.ts"],
    clearMocks: true
  }
});

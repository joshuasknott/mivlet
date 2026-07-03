import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@fable/protocol": fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url)),
      "@fable/connectors": fileURLToPath(new URL("../../packages/connectors/src/index.ts", import.meta.url)),
      "cloudflare:workers": fileURLToPath(new URL("./src/cloudflare-workers-test-shim.ts", import.meta.url))
    }
  },
  test: {
    include: ["src/**/*.test.ts"],
    clearMocks: true
  }
});

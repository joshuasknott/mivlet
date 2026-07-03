import { defineConfig } from "astro/config";

// Static site per spec. No adapter for CF pages (owner later decision).
export default defineConfig({
  output: "static",
  site: "https://example.com", // overridden at deploy
  build: {
    format: "directory"
  }
});

import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import production from "../../apps/desktop/vite.config.ts";
const desktopRequire = createRequire(
  new URL("../../apps/desktop/package.json", import.meta.url),
);

export default {
  ...production,
  resolve: {
    ...production.resolve,
    alias: {
      ...production.resolve?.alias,
      react: dirname(desktopRequire.resolve("react/package.json")),
      "react-dom": dirname(desktopRequire.resolve("react-dom/package.json")),
    },
  },
  root: fileURLToPath(new URL("../../", import.meta.url)),
  build: {
    ...production.build,
    outDir: "output/renderer-benchmark",
    emptyOutDir: true,
    rollupOptions: {
      ...production.build.rollupOptions,
      input: fileURLToPath(new URL("./renderer/index.html", import.meta.url)),
    },
  },
  server: { host: "127.0.0.1", port: 4274, strictPort: true },
  preview: { host: "127.0.0.1", port: 4274, strictPort: true },
};

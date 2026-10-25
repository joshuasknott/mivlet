import { resolve } from "node:path";

const [, , root, outfile, target] = Bun.argv;
const result = await Bun.build({
  entrypoints: [resolve(root, "src/main.ts")],
  target: "bun",
  plugins: [
    {
      name: "mivlet-linux-pty-sidecar",
      setup(build) {
        build.onResolve({ filter: /^@opencode-ai\/pty$/ }, () => ({
          path: resolve(root, "scripts/pty-shim.mjs"),
        }));
      },
    },
  ],
  compile: {
    outfile: resolve(root, outfile),
    target,
    // Keep Linux compilation aligned with the Windows CLI flags. The host
    // receives a private cwd and a cleared environment from native code;
    // neither ambient dotenv files nor bunfig preloads may cross that boundary.
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

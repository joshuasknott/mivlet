import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import production from "../../apps/desktop/vite.config.ts";
import { bundleProfile } from "./profile.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== commit)
  throw new Error(
    "Bundle profile checkout does not match the dispatched commit",
  );

export default {
  ...production,
  plugins: [...production.plugins, bundleProfile({ repoRoot, commit })],
};

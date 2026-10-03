import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyAdvisories,
  verifyDependencyPatches,
} from "./dependency-patches.mjs";

try {
  const patches = verifyDependencyPatches();
  if (!process.env.npm_execpath)
    throw new Error("Run this gate with pnpm audit:pnpm");
  const audit = spawnSync(
    process.execPath,
    [
      process.env.npm_execpath,
      "audit",
      "--prod",
      "--audit-level=low",
      "--json",
    ],
    {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (audit.error || (audit.status !== 0 && audit.status !== 1)) {
    throw new Error(
      `pnpm audit failed: ${audit.error?.message ?? audit.stderr}`,
    );
  }
  const report = JSON.parse(audit.stdout);
  const { reviewed, unreviewed } = classifyAdvisories(report, patches);
  for (const advisory of reviewed) {
    console.log(
      `Locally patched: ${advisory.github_advisory_id} ${advisory.module_name} — ${advisory.title}`,
    );
  }
  if (unreviewed.length > 0) {
    for (const advisory of unreviewed) {
      console.error(
        `Unreviewed ${advisory.severity}: ${advisory.github_advisory_id} ${advisory.module_name} — ${advisory.title}`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log(
      "Production dependency audit passed; only the two source-verified local patches remain in the registry report.",
    );
  }
} catch (error) {
  console.error(`Dependency audit failed: ${error.message}`);
  process.exitCode = 1;
}

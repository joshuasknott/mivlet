import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runBudgetCheck } from "./budget-check.mjs";

function moduleId(id, repoRoot) {
  const normalized = id.replaceAll("\\", "/").replaceAll("\0", "");
  const root = repoRoot.replaceAll("\\", "/").replace(/\/$/, "");
  const offset = normalized.toLowerCase().indexOf(`${root.toLowerCase()}/`);
  if (offset !== -1) return normalized.slice(offset + root.length + 1);
  // Virtual IDs are useful; unrelated absolute host paths are not.
  if (/^(?:[A-Za-z]:\/|\/)/.test(normalized))
    return `[external]/${normalized.split("/").at(-1)}`;
  return normalized;
}

/** Observes final output without changing the production graph or minifier. */
export function bundleProfile({ repoRoot, commit }) {
  let distDir;
  return {
    name: "production-bundle-profile",
    apply: "build",
    configResolved(config) {
      distDir = resolve(config.root, config.build.outDir);
    },
    writeBundle: {
      order: "post",
      sequential: true,
      async handler(_options, bundle) {
        const result = await runBudgetCheck({ distDir });
        const chunks = Object.values(bundle)
          .filter((entry) => entry.type === "chunk")
          .map((entry) => ({
            fileName: entry.fileName,
            isEntry: entry.isEntry,
            isDynamicEntry: entry.isDynamicEntry,
            imports: entry.imports,
            dynamicImports: entry.dynamicImports,
            modules: Object.entries(entry.modules)
              .map(([id, module]) => ({
                id: moduleId(id, repoRoot),
                renderedLength: module.renderedLength,
              }))
              .sort((a, b) => b.renderedLength - a.renderedLength),
          }))
          .sort((a, b) => a.fileName.localeCompare(b.fileName));
        const sha256 = (data) =>
          createHash("sha256").update(data).digest("hex");
        const report = {
          commit,
          node: process.version,
          zlib: process.versions.zlib,
          platform: process.platform,
          lockfileSha256: sha256(
            await readFile(join(repoRoot, "pnpm-lock.yaml")),
          ),
          notes: [
            "Raw/gzip sizes use the unchanged budget collector on files written to dist.",
            "Module renderedLength is before minification; module gzip sizes are not additive.",
            "This profile is not full validation, UI acceptance, or native/live evidence.",
          ],
          summary: result.summary,
          violations: result.violations,
          assets: result.assets,
          chunks,
        };
        const reportPath = join(repoRoot, "output/bundle-profile/report.json");
        await mkdir(dirname(reportPath), { recursive: true });
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        console.log(`Bundle profile: ${JSON.stringify(report.summary)}`);
      },
    },
  };
}

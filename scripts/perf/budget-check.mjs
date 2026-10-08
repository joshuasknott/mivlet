import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  collectAssets,
  formatBytes,
  formatKiB,
  summarizeBundle,
} from "./assets.mjs";

/**
 * Budget enforcement (raw byte ceilings + margins).
 * Rationale:
 * - Use raw bytes for primary signal (gzip varies slightly with zlib/node version).
 * - Ceilings set with explicit margins (8-24 KiB) above post-polish observed to absorb
 *   legitimate small growth + hash churn without false positives.
 * - Route chunks identified by logical name (Page/Panel suffix); extra unbudgeted assets (e.g. future pages)
 *   do not violate as long as budgeted ones stay under.
 * - Tests cover: missing builds (ENOENT), malformed JSON, path seps, exact ceiling pass vs +1 fail, unexpected assets.
 * - Runtime / memory not gated here (see packages/* /performance-baseline.test.ts for loose info checks).
 */

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const desktopDist = join(repoRoot, "apps", "desktop", "dist");
const budgetPath = join(scriptDir, "budget.json");

export async function loadBudget(path = budgetPath) {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

function compareCeiling(label, actualBytes, ceilingBytes, baselineBytes) {
  // <= passes (exact ceiling is allowed; +1 fails). This makes threshold boundary tests deterministic.
  if (actualBytes <= ceilingBytes) return undefined;
  const overBytes = actualBytes - ceilingBytes;
  const baselineNote =
    baselineBytes === undefined
      ? ""
      : ` (recorded baseline ${formatKiB(baselineBytes)})`;
  return {
    label,
    actualBytes,
    ceilingBytes,
    overBytes,
    message: `${label}: ${formatKiB(actualBytes)} > ceiling ${formatKiB(ceilingBytes)} (+${formatKiB(overBytes)})${baselineNote}`,
  };
}

export function checkBudget(summary, budget) {
  const violations = [];
  // Renderer growth cannot consume the budget of the ordinary workspace.
  for (const group of ["commonJsCss", "pdfPreview"]) {
    if (!budget.ceilings[group] || !summary[group]) continue;
    const actual = summary[group];
    for (const [unit, key] of [
      ["raw", "rawBytes"],
      ["gzip", "gzipBytes"],
    ]) {
      const violation = compareCeiling(
        `${group}.${unit}`,
        actual[key],
        budget.ceilings[group][key],
      );
      if (violation) violations.push(violation);
    }
  }

  const totalViolation = compareCeiling(
    "totalJsCss.raw",
    summary.totalJsCss.rawBytes,
    budget.ceilings.totalJsCss.rawBytes,
    budget.recordedBaseline.totalJsCss.rawBytes,
  );
  if (totalViolation) violations.push(totalViolation);

  const totalGzipViolation = compareCeiling(
    "totalJsCss.gzip",
    summary.totalJsCss.gzipBytes,
    budget.ceilings.totalJsCss.gzipBytes,
    budget.recordedBaseline.totalJsCss.gzipBytes,
  );
  if (totalGzipViolation) violations.push(totalGzipViolation);

  const cssViolation = compareCeiling(
    "css.raw",
    summary.css.rawBytes,
    budget.ceilings.css.rawBytes,
    budget.recordedBaseline.css.rawBytes,
  );
  if (cssViolation) violations.push(cssViolation);

  if (summary.initialEntryJs) {
    const entryViolation = compareCeiling(
      "initialEntryJs.raw",
      summary.initialEntryJs.rawBytes,
      budget.ceilings.initialEntryJs.rawBytes,
      budget.recordedBaseline.initialEntryJs?.rawBytes,
    );
    if (entryViolation) violations.push(entryViolation);
  } else {
    violations.push({
      label: "initialEntryJs.raw",
      message: "initialEntryJs.raw: missing index-*.js entry chunk in dist",
    });
  }

  for (const [chunkId, ceiling] of Object.entries(
    budget.ceilings.routeChunks,
  )) {
    const actual = summary.routeChunks[chunkId];
    if (!actual) {
      violations.push({
        label: `routeChunks.${chunkId}.raw`,
        message: `routeChunks.${chunkId}.raw: expected lazy route chunk missing from dist`,
      });
      continue;
    }
    const routeViolation = compareCeiling(
      `routeChunks.${chunkId}.raw`,
      actual.rawBytes,
      ceiling.rawBytes,
      budget.recordedBaseline.routeChunks?.[chunkId]?.rawBytes,
    );
    if (routeViolation) violations.push(routeViolation);
  }

  return violations;
}

export function formatViolationReport(violations, budget) {
  const lines = [
    "Performance budget exceeded.",
    "",
    "Failures:",
    ...violations.map((violation) => `- ${violation.message}`),
    "",
    "Recorded baseline (for comparison):",
    `- total JS+CSS: ${formatBytes(budget.recordedBaseline.totalJsCss.rawBytes)} raw / ${formatBytes(budget.recordedBaseline.totalJsCss.gzipBytes)} gzip`,
    `- CSS: ${formatBytes(budget.recordedBaseline.css.rawBytes)} raw`,
    `- Settings route: ${formatBytes(budget.recordedBaseline.routeChunks.SettingsPage.rawBytes)} raw`,
    "",
    "Ceilings guard material regression above the current recorded repository build.",
    "Hash suffixes are ignored; gzip tolerance is intentionally wider than raw.",
  ];
  return `${lines.join("\n")}\n`;
}

export async function runBudgetCheck({
  distDir = desktopDist,
  budgetFile = budgetPath,
} = {}) {
  const budget = await loadBudget(budgetFile);
  const assets = await collectAssets(distDir, repoRoot);
  const summary = summarizeBundle(assets);
  const violations = checkBudget(summary, budget);
  if (budget.requireDeferredPdf) {
    const manifest = JSON.parse(
      await readFile(join(distDir, ".vite", "manifest.json"), "utf8"),
    );
    violations.push(...checkDeferredPdf(manifest));
  }
  return { budget, assets, summary, violations };
}

/** Walk static imports, never dynamicImports, to check the actual startup graph. */
export function checkDeferredPdf(manifest) {
  const eager = new Set();
  const violations = [];
  if (!Object.values(manifest).some((chunk) => chunk.isEntry)) {
    violations.push({
      label: "deferred.entry",
      message: "Missing startup entry in the Vite build manifest",
    });
  }
  const visit = (key) => {
    if (eager.has(key)) return;
    eager.add(key);
    if (!manifest[key]) {
      violations.push({
        label: "deferred.import",
        message: `Missing static import ${key} in the Vite build manifest`,
      });
    }
    for (const imported of manifest[key]?.imports ?? []) visit(imported);
  };
  for (const [key, chunk] of Object.entries(manifest))
    if (chunk.isEntry) visit(key);
  for (const prefix of ["PdfPreview-", "pdf-renderer-"]) {
    const keys = Object.keys(manifest).filter((key) =>
      manifest[key].file?.split("/").at(-1)?.startsWith(prefix),
    );
    if (keys.length !== 1 || keys.some((key) => eager.has(key))) {
      violations.push({
        label: `deferred.${prefix}`,
        message: `${prefix}: expected one PDF-only chunk outside all static entry imports`,
      });
    }
  }
  for (const key of eager) {
    if (
      (manifest[key]?.assets ?? []).some((asset) =>
        /pdf\.worker\.min-/.test(asset),
      )
    ) {
      violations.push({
        label: "deferred.pdf-worker",
        message:
          "PDF worker asset is referenced by an initial entry dependency",
      });
    }
  }
  return violations;
}

async function main() {
  const { violations, budget, summary } = await runBudgetCheck();
  process.stdout.write(`Measured bundle bytes: ${JSON.stringify(summary)}\n`);
  if (violations.length === 0) {
    process.stdout.write("Performance budget check passed.\n");
    return;
  }
  process.stderr.write(formatViolationReport(violations, budget));
  process.exitCode = 1;
}

const invokedAsCli =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsCli) {
  main().catch((error) => {
    // Actionable output for error paths exercised by tests (ENOENT missing dist, bad JSON, etc).
    // Keep stack for unexpected, short message for common fs/json issues.
    if (
      error &&
      (error.code === "ENOENT" || /ENOENT/.test(error.message || ""))
    ) {
      console.error(
        "Performance budget check failed: dist directory not found. Run `pnpm build` first.",
      );
    } else if (
      error &&
      (error instanceof SyntaxError || /JSON|parse/i.test(error.message || ""))
    ) {
      console.error(
        "Performance budget check failed: malformed budget.json - " +
          (error.message || error),
      );
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });
}

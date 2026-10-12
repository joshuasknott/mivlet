import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// No vulnerability exceptions remain. Reject missing/inconsistent audit data
// rather than treating a failed or unfamiliar report as an empty result.
export function validateCargoAuditReport(report) {
  const vulnerabilities = report?.vulnerabilities;
  if (
    !Array.isArray(vulnerabilities?.list) ||
    !Number.isInteger(vulnerabilities.count) ||
    vulnerabilities.count !== vulnerabilities.list.length ||
    vulnerabilities.found !== vulnerabilities.count > 0
  ) {
    throw new Error("cargo audit returned an incomplete vulnerability report");
  }
  if (vulnerabilities.count > 0) {
    throw new Error(
      `unreviewed vulnerabilities found: ${vulnerabilities.list
        .map(
          (finding) =>
            `${finding.advisory?.id ?? "unknown advisory"} ${finding.package?.name ?? "unknown package"}@${finding.package?.version ?? "unknown version"}`,
        )
        .join(", ")}`,
    );
  }
  const warnings = Object.values(report.warnings ?? {});
  if (warnings.some((entries) => !Array.isArray(entries))) {
    throw new Error("cargo audit returned an incomplete warning report");
  }
  return warnings.reduce((total, entries) => total + entries.length, 0);
}

function main() {
  const repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const lockfilePath = join(
    repositoryRoot,
    "apps/desktop/src-tauri/Cargo.lock",
  );
  const audit = spawnSync(
    process.platform === "win32" ? "cargo.exe" : "cargo",
    ["audit", "--file", lockfilePath, "--json"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (audit.error || (audit.status !== 0 && audit.status !== 1)) {
    throw new Error(
      `cargo audit could not run: ${audit.error?.message ?? audit.stderr}`,
    );
  }
  let report;
  try {
    report = JSON.parse(audit.stdout);
  } catch {
    throw new Error(`cargo audit did not return valid JSON: ${audit.stderr}`);
  }
  const warningCount = validateCargoAuditReport(report);
  if (audit.status !== 0)
    throw new Error(`cargo audit failed: ${audit.stderr}`);
  console.log("Cargo audit passed with no vulnerability exceptions.");
  console.log(
    `Cargo audit reported ${warningCount} informational maintenance/unsoundness warning(s); these remain visible and are not vulnerability exceptions.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(`Cargo audit policy failed: ${error.message}`);
    process.exitCode = 1;
  }
}

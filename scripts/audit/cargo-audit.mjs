import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifestPath = join(
  repositoryRoot,
  "apps",
  "desktop",
  "src-tauri",
  "Cargo.toml",
);
const lockfilePath = join(
  repositoryRoot,
  "apps",
  "desktop",
  "src-tauri",
  "Cargo.lock",
);
const policyPath = join(dirname(fileURLToPath(import.meta.url)), "rustsec-policy.json");
const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";

function fail(message) {
  console.error(`Cargo audit policy failed: ${message}`);
  process.exit(1);
}

function runCargo(args, options = {}) {
  return spawnSync(cargo, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

function findRegistrySource(crateDirectory) {
  const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
  const registryRoot = join(cargoHome, "registry", "src");
  if (!existsSync(registryRoot)) {
    return undefined;
  }

  for (const registry of readdirSync(registryRoot, { withFileTypes: true })) {
    if (!registry.isDirectory()) {
      continue;
    }
    const candidate = join(registryRoot, registry.name, crateDirectory, "src", "lib.rs");
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

const policy = JSON.parse(readFileSync(policyPath, "utf8"));
if (policy.schemaVersion !== 1 || policy.exceptions.length !== 1) {
  fail("the checked policy must contain exactly the reviewed schema-v1 exception");
}

const exception = policy.exceptions[0];
const expiry = Date.parse(`${exception.expiresOn}T23:59:59Z`);
if (!Number.isFinite(expiry) || Date.now() > expiry) {
  fail(`the ${exception.package} exception expired on ${exception.expiresOn}`);
}

const fetch = runCargo(["fetch", "--manifest-path", manifestPath, "--locked"]);
if (fetch.status !== 0) {
  process.stderr.write(fetch.stderr);
  fail("Cargo dependencies could not be fetched for source inspection");
}

const tree = runCargo([
  "tree",
  "--manifest-path",
  manifestPath,
  "--locked",
  "--invert",
  `${exception.package}@${exception.version}`,
]);
if (tree.status !== 0) {
  process.stderr.write(tree.stderr);
  fail(`the reviewed ${exception.package}@${exception.version} path was not found`);
}
for (const dependency of exception.dependencyPath) {
  if (!tree.stdout.includes(dependency)) {
    fail(`the reviewed dependency path no longer contains ${dependency}`);
  }
}

const sourcePath = findRegistrySource(
  `${exception.introducedBy}-${exception.introducedByVersion}`,
);
if (!sourcePath) {
  fail(
    `${exception.introducedBy}@${exception.introducedByVersion} source was not found after cargo fetch`,
  );
}

const source = readFileSync(sourcePath, "utf8");
const quickXmlReferences = source.match(/quick_xml::[A-Za-z0-9_:]+/g) ?? [];
if (quickXmlReferences.length === 0) {
  fail("the reviewed notification source no longer contains the expected escape calls");
}
if (
  quickXmlReferences.some(
    (reference) => reference !== exception.allowedSourceReference,
  )
) {
  fail(
    `the notification source now uses an unreviewed quick-xml API: ${[
      ...new Set(quickXmlReferences),
    ].join(", ")}`,
  );
}

const affectedParserApis = [
  /\bNsReader\b/,
  /\bNamespaceResolver\b/,
  /quick_xml::Reader\b/,
  /\.attributes\s*\(/,
  /\btry_get_attribute\b/,
];
if (affectedParserApis.some((pattern) => pattern.test(source))) {
  fail("an affected quick-xml parser API is now reachable from notification source");
}

const audit = runCargo(["audit", "--file", lockfilePath, "--json"]);
if (audit.error || (audit.status !== 0 && audit.status !== 1)) {
  process.stderr.write(audit.stderr ?? "");
  fail(`cargo audit could not run${audit.error ? `: ${audit.error.message}` : ""}`);
}

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  process.stderr.write(audit.stdout);
  process.stderr.write(audit.stderr);
  fail("cargo audit did not return valid JSON");
}

const findings = report.vulnerabilities?.list ?? [];
const allowedAdvisories = new Set(exception.advisories);
const unreviewed = findings.filter((finding) => {
  const auditedPackage = finding.package;
  return (
    !allowedAdvisories.has(finding.advisory.id) ||
    auditedPackage.name !== exception.package ||
    auditedPackage.version !== exception.version
  );
});
if (unreviewed.length > 0) {
  fail(
    `unreviewed vulnerabilities found: ${unreviewed
      .map(
        (finding) =>
          `${finding.advisory.id} ${finding.package.name}@${finding.package.version}`,
      )
      .join(", ")}`,
  );
}

const observedAllowed = new Set(findings.map(({ advisory }) => advisory.id));
for (const advisory of allowedAdvisories) {
  if (!observedAllowed.has(advisory)) {
    fail(
      `${advisory} is no longer reported; remove or revise the exception instead of retaining stale suppression`,
    );
  }
}

const warningCount = Object.values(report.warnings ?? {}).reduce(
  (total, entries) => total + entries.length,
  0,
);
console.log(
  `Cargo audit passed with ${findings.length} reviewed notification-only ` +
    `finding(s), expiring ${exception.expiresOn}.`,
);
console.log(
  `Source proof: ${quickXmlReferences.length} quick-xml reference(s), all ` +
    `${exception.allowedSourceReference}; affected parser APIs absent.`,
);
console.log(
  `Cargo audit also reported ${warningCount} informational cross-platform ` +
    "maintenance/unsoundness warning(s); these are visible but are not vulnerability findings.",
);

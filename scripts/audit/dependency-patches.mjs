import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);

export function verifyDependencyPatches(
  repositoryRoot = root,
  now = Date.now(),
) {
  const policy = JSON.parse(
    readFileSync(
      join(repositoryRoot, "scripts/audit/pnpm-patches.json"),
      "utf8",
    ),
  );
  if (
    policy.schemaVersion !== 1 ||
    !Array.isArray(policy.patches) ||
    policy.patches.length !== 2
  ) {
    throw new Error("Invalid dependency patch policy");
  }
  const store = join(repositoryRoot, "node_modules/.pnpm");
  // pnpm retains obsolete store directories after updates. Inspect only the
  // snapshots in the installed graph, including every active package version.
  const installedLock = readFileSync(join(store, "lock.yaml"), "utf8");
  const snapshots = installedLock.split("\nsnapshots:\n")[1];
  if (!snapshots) throw new Error("Missing installed dependency snapshots");
  const entries = [
    ...snapshots.matchAll(
      /^  (braces@[^\n:]+|http-cache-semantics@[^\n:]+):/gm,
    ),
  ].map((match) =>
    match[1].replace(/\(patch_hash=([^)]*)\)/g, "_patch_hash=$1"),
  );
  return policy.patches.map((patch) => {
    const expiry = Date.parse(`${patch.expiresOn}T23:59:59Z`);
    if (!Number.isFinite(expiry) || now > expiry) {
      throw new Error(
        `Review the expired ${patch.package} patch (${patch.expiresOn})`,
      );
    }
    const copies = entries.filter((entry) =>
      entry.startsWith(`${patch.package}@`),
    );
    if (copies.length === 0)
      throw new Error(`Missing installed ${patch.package} patch`);
    const directories = copies.map((entry) => {
      const directory = join(store, entry, "node_modules", patch.package);
      const pkg = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      );
      if (pkg.name !== patch.package || pkg.version !== patch.version) {
        throw new Error(`Unreviewed ${pkg.name}@${pkg.version}`);
      }
      for (const [file, expected] of Object.entries(patch.sha256)) {
        const actual = createHash("sha256")
          .update(readFileSync(join(directory, file)))
          .digest("hex");
        if (actual !== expected)
          throw new Error(`Missing or changed patch: ${patch.package}/${file}`);
      }
      return directory;
    });
    return { ...patch, directories };
  });
}

export function loadPatchedPackage(directory) {
  return require(directory);
}

export function classifyAdvisories(report, patches) {
  if (
    !report.advisories ||
    typeof report.advisories !== "object" ||
    Array.isArray(report.advisories) ||
    !report.metadata?.vulnerabilities ||
    !Array.isArray(report.muted) ||
    report.muted.length !== 0
  ) {
    throw new Error("Audit returned an invalid or muted report");
  }
  const reviewed = [];
  const unreviewed = [];
  for (const advisory of Object.values(report.advisories)) {
    const patch = patches.find(
      (entry) =>
        entry.advisory === advisory.github_advisory_id &&
        entry.package === advisory.module_name &&
        Array.isArray(advisory.findings) &&
        advisory.findings.length > 0 &&
        advisory.findings.every((finding) => finding.version === entry.version),
    );
    (patch ? reviewed : unreviewed).push(advisory);
  }
  for (const patch of patches) {
    if (
      !reviewed.some(
        (advisory) => advisory.github_advisory_id === patch.advisory,
      )
    ) {
      throw new Error(
        `${patch.advisory} is no longer reported; remove or revise its local patch policy`,
      );
    }
  }
  return { reviewed, unreviewed };
}

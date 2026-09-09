import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ALLOWED_CHANNELS = new Set(["private", "internal", "preview"]);
const ARTIFACT_KINDS = new Map([
  [".msi", "windows-msi"],
  [".exe", "windows-nsis"]
]);

function assertText(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`${label} must be non-empty and at most 200 characters.`);
  }
  return value.trim();
}

function cargoPackageVersion(source) {
  const packageSection = source.match(/(?:^|\r?\n)\[package\]\s*\r?\n([\s\S]*?)(?=\r?\n\[|$)/)?.[1];
  const version = packageSection?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!version) throw new Error("apps/desktop/src-tauri/Cargo.toml is missing package.version.");
  return version;
}

export async function assertReleaseVersionAlignment({
  rootPackagePath = "package.json",
  desktopPackagePath = "apps/desktop/package.json",
  tauriConfigPath = "apps/desktop/src-tauri/tauri.conf.json",
  cargoManifestPath = "apps/desktop/src-tauri/Cargo.toml"
} = {}) {
  const [rootPackage, desktopPackage, tauriConfig, cargoManifest] = await Promise.all([
    readFile(rootPackagePath, "utf8").then(JSON.parse),
    readFile(desktopPackagePath, "utf8").then(JSON.parse),
    readFile(tauriConfigPath, "utf8").then(JSON.parse),
    readFile(cargoManifestPath, "utf8")
  ]);
  const versions = new Map([
    ["package.json", rootPackage.version],
    ["apps/desktop/package.json", desktopPackage.version],
    ["apps/desktop/src-tauri/tauri.conf.json", tauriConfig.version],
    ["apps/desktop/src-tauri/Cargo.toml", cargoPackageVersion(cargoManifest)]
  ]);
  for (const [source, version] of versions) assertText(version, `${source} version`);
  if (new Set(versions.values()).size !== 1) {
    throw new Error(
      `Release versions are not aligned: ${[...versions].map(([source, version]) => `${source}=${version}`).join(", ")}`
    );
  }
  return versions.values().next().value;
}

export function assertReleaseMetadata({ version, channel, commit, createdAt }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(assertText(version, "version"))) {
    throw new Error("version must be a semantic version.");
  }
  if (!ALLOWED_CHANNELS.has(channel)) {
    throw new Error("channel must be private, internal, or preview; public publication is not repository-authorized.");
  }
  if (!/^[0-9a-f]{7,64}$/i.test(assertText(commit, "commit"))) {
    throw new Error("commit must be a Git commit identifier.");
  }
  const parsedCreatedAt = new Date(assertText(createdAt, "createdAt"));
  if (Number.isNaN(parsedCreatedAt.getTime()) || parsedCreatedAt.toISOString() !== createdAt) {
    throw new Error("createdAt must be a canonical ISO timestamp.");
  }
}

async function sha256(path) {
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex");
}

export async function collectWindowsArtifacts(directory) {
  const root = resolve(directory);
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  const artifacts = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = extname(entry.name).toLowerCase();
    const kind = ARTIFACT_KINDS.get(extension);
    if (!kind) continue;
    const parent = entry.parentPath ?? entry.path;
    const path = join(parent, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`Release artifact cannot be a symbolic link: ${entry.name}`);
    artifacts.push({
      kind,
      fileName: basename(path),
      relativePath: relative(root, path).replaceAll("\\", "/"),
      bytes: metadata.size,
      sha256: await sha256(path),
      signed: false
    });
  }
  artifacts.sort((left, right) => left.kind.localeCompare(right.kind) || left.fileName.localeCompare(right.fileName));
  const kinds = new Set(artifacts.map((artifact) => artifact.kind));
  for (const required of ARTIFACT_KINDS.values()) {
    if (!kinds.has(required)) throw new Error(`Missing required ${required} artifact.`);
  }
  if (artifacts.length !== kinds.size) throw new Error("Release staging contains duplicate installer kinds.");
  return artifacts;
}

export function buildManifest({ version, channel, commit, createdAt, artifacts }) {
  assertReleaseMetadata({ version, channel, commit, createdAt });
  if (!Array.isArray(artifacts) || artifacts.length !== 2) {
    throw new Error("Exactly one MSI and one NSIS artifact are required.");
  }
  return {
    schemaVersion: 1,
    product: "Fable",
    version,
    channel,
    commit,
    createdAt,
    platform: "windows",
    architecture: "x86_64",
    signed: false,
    publication: "not-published",
    updater: "not-published",
    artifacts
  };
}

export function renderReleaseNotes(manifest) {
  return `# Fable ${manifest.version} (${manifest.channel})

Commit: \`${manifest.commit}\`

## Unsigned Windows artifacts

${manifest.artifacts.map((artifact) => `- ${artifact.fileName} — ${artifact.bytes} bytes — SHA-256 \`${artifact.sha256}\``).join("\n")}

## Repository evidence

- Built from the locked repository on Windows CI.
- MSI and NSIS artifacts are checksummed in \`release-manifest.json\`.
- The release manifest explicitly records unsigned and unpublished state.

## Still gated

- Code signing and signing-material custody
- Public download hosting and updater publication
- Packaged clean-install, upgrade, rollback, and private soak approval
- Live Clerk/Convex, provider, OAuth, MCP, and multi-account validation

This artifact set is for private validation only. It is not a public release.
`;
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    args.set(process.argv[index], process.argv[index + 1]);
  }
  const directory = args.get("--artifacts");
  const output = args.get("--output");
  const notes = args.get("--notes");
  const packageJsonPath = args.get("--package") ?? "apps/desktop/package.json";
  if (!directory || !output || !notes) {
    throw new Error("Usage: windows-manifest --artifacts <dir> --output <json> --notes <md> --commit <sha> --created-at <ISO> [--channel private]");
  }
  const alignedVersion = await assertReleaseVersionAlignment({ desktopPackagePath: packageJsonPath });
  const requestedVersion = args.get("--version");
  if (requestedVersion && requestedVersion !== alignedVersion) {
    throw new Error(`Requested release version ${requestedVersion} does not match repository version ${alignedVersion}.`);
  }
  const manifest = buildManifest({
    version: alignedVersion,
    channel: args.get("--channel") ?? "private",
    commit: args.get("--commit"),
    createdAt: args.get("--created-at"),
    artifacts: await collectWindowsArtifacts(directory)
  });
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  await writeFile(notes, renderReleaseNotes(manifest), { flag: "wx" });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

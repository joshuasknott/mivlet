// Release maintenance: node collect-cua-notices.mjs <pinned-upstream-checkout> <cargo-metadata.json>
// Metadata must be produced with --locked --filter-platform x86_64-pc-windows-msvc.
import { readFile, writeFile, mkdir, readdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const [upstream, metadataFile] = process.argv.slice(2);
if (!upstream || !metadataFile) throw new Error("Supply the pinned Cua checkout and its Windows cargo metadata.");
const resources = fileURLToPath(new URL("../src-tauri/resources/cua-driver/", import.meta.url));
const pin = JSON.parse(await readFile(join(resources, "runtime.json"), "utf8"));
const revision = execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
if (revision !== pin.sourceCommit) throw new Error("Cua source does not match the release pin.");
const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
const packages = new Map(metadata.packages.map((p) => [p.id, p]));
const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
const root = metadata.packages.find((p) => p.name === "cua-driver" && p.version === pin.version);
if (!root) throw new Error("The pinned driver is absent from metadata.");
const included = new Set();
function visit(id) {
  if (included.has(id)) return;
  included.add(id);
  for (const dep of nodes.get(id)?.deps ?? []) {
    if (dep.dep_kinds.some((kind) => kind.kind !== "dev")) visit(dep.pkg);
  }
}
visit(root.id);
const lock = await readFile(join(upstream, "libs/cua-driver/rust/Cargo.lock"), "utf8");
const checksums = new Map([...lock.matchAll(/\[\[package\]\]\s+name = "([^"]+)"\s+version = "([^"]+)"\s+source = "[^"]+"\s+checksum = "([^"]+)"/g)].map((m) => [`${m[1]}-${m[2]}`, m[3]]));
const output = join(resources, "third-party");
await mkdir(join(output, "sources"), { recursive: true });
await copyFile(join(upstream, "LICENSE.md"), join(resources, "LICENSE-CUA.txt"));
await copyFile(join(upstream, "libs/cua-driver/rust/crates/cursor-overlay/assets/Inter-OFL.txt"), join(output, "Inter-OFL.txt"));
let notices = `Cua Driver ${pin.version}\nSource: https://github.com/trycua/cua/tree/${revision}/libs/cua-driver\n\nUnmodified upstream executable. This inventory includes normal and build dependencies\nreachable from the Windows executable in the pinned Cargo.lock. It may overinclude\nfeature-unified build dependencies. Cua's MIT notice and Inter's OFL are alongside.\nMPL source archives are in sources/, unmodified and verified against Cargo.lock.\n\n`;
const inventory = [];
async function licenses(directory, depth = 0) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && /^(license|licence|copying|copyright|notice|third.party)/i.test(entry.name)) result.push(path);
    else if (entry.isDirectory() && depth < 3 && ![".git", "target", "node_modules"].includes(entry.name)) result.push(...await licenses(path, depth + 1));
  }
  return result.sort();
}
for (const p of [...included].map((id) => packages.get(id)).sort((a,b) => `${a.name}-${a.version}`.localeCompare(`${b.name}-${b.version}`))) {
  const name = `${p.name}-${p.version}`;
  const license = p.license ?? (p.source === null ? "MIT (Cua repository LICENSE.md)" : null);
  if (!license) throw new Error(`Missing license for ${name}.`);
  const directory = dirname(p.manifest_path);
  const files = await licenses(directory);
  notices += `\n${"=".repeat(72)}\n${name}\nLicense: ${license}\nSource: ${p.repository ?? p.source ?? "Cua repository"}\n`;
  let licenseSource;
  if (p.source && !files.length) {
    // These published crates omit their repository-level license file.
    const reviewed = ["https://github.com/DoumanAsh/clipboard-win", "https://github.com/Stranger6667/jsonschema", "https://github.com/mozilla/uniffi-rs", "https://github.com/Nugine/simd"];
    if (!reviewed.includes(p.repository)) throw new Error(`Review the missing license for ${name}.`);
    const vcs = JSON.parse(await readFile(join(directory, ".cargo_vcs_info.json"), "utf8")).git.sha1;
    if (!/^[0-9a-f]{40}$/.test(vcs)) throw new Error(`Invalid source revision for ${name}.`);
    licenseSource = `${p.repository.replace("https://github.com/", "https://raw.githubusercontent.com/")}/${vcs}/LICENSE`;
    const response = await fetch(licenseSource);
    if (!response.ok) throw new Error(`Could not fetch the exact source license for ${name}.`);
    notices += `\n--- Repository LICENSE (${licenseSource}) ---\n${await response.text()}\n`;
  }
  for (const file of files) {
    const bytes = await readFile(file);
    if (bytes.includes(0)) continue;
    notices += `\n--- ${relative(directory, file).replaceAll("\\", "/")} ---\n${bytes.toString("utf8")}\n`;
  }
  const item = { name:p.name, version:p.version, license, source:p.source, checksum:checksums.get(name) ?? null };
  if (licenseSource) item.licenseSource = licenseSource;
  if (license.includes("MPL-2.0")) {
    const registry = dirname(dirname(directory));
    const archive = join(dirname(registry), "cache", basename(dirname(directory)), `${name}.crate`);
    const bytes = await readFile(archive);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== checksums.get(name)) throw new Error(`Source checksum mismatch for ${name}.`);
    await copyFile(archive, join(output, "sources", `${name}.crate`));
    item.sourceArchive = `sources/${name}.crate`;
  }
  inventory.push(item);
}
await writeFile(join(output, "NOTICES.txt"), notices);
await writeFile(join(output, "inventory.json"), `${JSON.stringify({ driverVersion:pin.version, sourceCommit:revision, target:pin.target, dependencies:inventory }, null, 2)}\n`);
console.log(`Collected notices for ${inventory.length} dependencies, including unmodified MPL sources.`);

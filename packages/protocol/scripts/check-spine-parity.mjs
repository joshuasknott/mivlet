import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import path from "node:path";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(packageRoot, "spine-parity-manifest.json"), "utf8"));
const spine = await import(pathToFileURL(path.join(packageRoot, "dist/spine/index.js")).href);

function fail(message) {
  throw new Error(`Product-spine parity: ${message}`);
}

function assertUnique(values, name) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    fail(`${name} must be an array of strings`);
  }
  if (new Set(values).size !== values.length) fail(`${name} contains duplicate values`);
}

function sourceVocabularyNames(source) {
  return [...source.matchAll(/export const (\w+)\s*=\s*\[/g)].map((match) => match[1]).sort();
}

if (!/^\d+\.\d+\.\d+$/.test(manifest.contractVersion)) fail("contractVersion must be semver x.y.z");
if (!Number.isSafeInteger(manifest.schemaVersion) || manifest.schemaVersion < 1) fail("schemaVersion must be a positive integer");
if (spine.Primitives.PRODUCT_SPINE_CONTRACT_VERSION !== manifest.contractVersion) fail("contract version differs from the manifest");
if (spine.Primitives.PRODUCT_SPINE_SCHEMA_VERSION !== manifest.schemaVersion) fail("schema version differs from the manifest");

const limits = Object.entries(manifest.limits ?? {}).sort(([left], [right]) => left.localeCompare(right));
if (!limits.length) fail("missing required numeric limits");
for (const [name, value] of limits) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`limit ${name} must be a positive integer`);
  const owners = Object.entries(spine).filter(([, family]) => family?.[name] !== undefined);
  if (owners.length !== 1) fail(`limit ${name} must be exported by exactly one family`);
  if (owners[0][1][name] !== value) fail(`limit ${name} differs from the manifest`);
}

const requiredFamilies = ["Identity", "Connections", "Conversations"];
if (!Array.isArray(manifest.families) || manifest.families.length !== requiredFamilies.length) fail("missing required family");
const suppliedFamilies = manifest.families.map(({ name }) => name);
if (new Set(suppliedFamilies).size !== suppliedFamilies.length || requiredFamilies.some((name) => !suppliedFamilies.includes(name))) {
  fail("missing or duplicate required family");
}

const families = [];
for (const family of [...manifest.families].sort((left, right) => left.name.localeCompare(right.name))) {
  const source = await readFile(path.join(packageRoot, "src/spine", family.source), "utf8");
  const names = sourceVocabularyNames(source);
  if (!names.length) fail(`${family.name} has no exported vocabulary`);
  const vocabulary = names.map((name) => {
    const values = spine[family.name]?.[name];
    assertUnique(values, `${family.name}.${name}`);
    return { name, values };
  });
  families.push({ name: family.name, vocabulary });
}

const canonical = JSON.stringify({
  contractVersion: manifest.contractVersion,
  schemaVersion: manifest.schemaVersion,
  limits,
  families
});
const actualSha256 = createHash("sha256").update(canonical).digest("hex");
if (!/^[a-f0-9]{64}$/.test(manifest.expectedCanonicalSha256)) fail("expectedCanonicalSha256 must be a lowercase SHA-256 digest");
if (actualSha256 !== manifest.expectedCanonicalSha256) {
  fail(`canonical vocabulary, version, or limits drifted from the manifest (${actualSha256})`);
}

const rustParitySource = await readFile(
  path.resolve(packageRoot, "../../apps/desktop/src-tauri/src/product_spine_parity.rs"),
  "utf8"
);
const rustMirror = rustParitySource.match(
  /const RUST_CANONICAL_SHA256:\s*&str\s*=\s*"([a-f0-9]{64})"/
);
if (!rustMirror) fail("Rust canonical digest mirror is missing or malformed");
if (rustMirror[1] !== manifest.expectedCanonicalSha256) {
  fail("Rust canonical digest mirror differs from the manifest");
}

console.log(`Product-spine parity passed (${actualSha256}).`);

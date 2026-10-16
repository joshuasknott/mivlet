import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDigest,
  assertPayloadPreserved,
  inventory,
  sha256,
} from "./candidate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../../..");
const buildDirectory = process.argv[2];
if (!buildDirectory || process.argv.length !== 3)
  throw new Error("Usage: stage-acceptance.mjs PREPARED_BUILD_DIRECTORY");
const recipeBytes = await readFile(join(here, "recipe.json"));
const recipe = JSON.parse(recipeBytes);
const receipt = JSON.parse(
  await readFile(join(buildDirectory, "artifact-receipt.json")),
);
const provenance = JSON.parse(
  await readFile(join(buildDirectory, "artifact/provenance.json")),
);
assertDigest(recipeBytes, provenance.prepared.recipeSha256, "candidate recipe");
assertDigest(
  await readFile(join(buildDirectory, receipt.archive)),
  receipt.sha256,
  "candidate archive",
);
if (
  receipt.candidate !== recipe.candidate ||
  provenance.candidate !== recipe.candidate ||
  provenance.build.exitCode !== 0 ||
  provenance.runtime.node !== recipe.version ||
  provenance.runtime.uv !== recipe.libuvVersion ||
  provenance.runtime.arch !== "x64" ||
  provenance.runtime.platform !== "win32"
)
  throw new Error(
    "Candidate build provenance differs from the reviewed recipe",
  );
const payload = join(buildDirectory, "artifact", recipe.candidate);
const files = await inventory(payload);
assertPayloadPreserved(
  provenance.prepared.officialFiles,
  files,
  receipt.executableSha256,
);
const executable = await readFile(join(payload, "node.exe"));
assertDigest(executable, receipt.executableSha256, "candidate executable");
const resources = join(
  repository,
  "apps/desktop/src-tauri/resources/execution-runtime",
);
const manifestPath = join(resources, "files.json");
const manifest = JSON.parse(await readFile(manifestPath));
const original = join(resources, "runtime/node/node.exe");
assertDigest(
  await readFile(original),
  provenance.prepared.officialFiles["node.exe"],
  "prepared official runtime before candidate staging",
);
await copyFile(join(payload, "node.exe"), original);
manifest.files["node/node.exe"] = sha256(executable);
// A normal app preparation must replace this test payload with its pinned
// production source rather than accidentally accepting a validation candidate.
manifest.sources[0] = {
  ...manifest.sources[0],
  url: `validation-candidate:${recipe.candidate}`,
  sha256: receipt.sha256,
};
manifest.nodeBackport = {
  candidate: recipe.candidate,
  executableSha256: receipt.executableSha256,
  recipeSha256: sha256(recipeBytes),
  upstreamCommit: recipe.patch.upstreamCommit,
  purpose: "native-acceptance-only",
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  "Staged the verified backport for native acceptance; production runtime selection is unchanged.",
);

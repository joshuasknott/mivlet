import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../../..");
const recipeBytes = await readFile(join(here, "recipe.json"));
const recipe = JSON.parse(recipeBytes);
const patchBytes = await readFile(join(here, recipe.patch.file));
const recipeInputs = [
  "candidate.mjs",
  "build.ps1",
  "recipe.json",
  recipe.patch.file,
  "LICENSE.libuv",
];

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export function assertDigest(bytes, expected, description) {
  if (!/^[a-f0-9]{64}$/.test(expected) || sha256(bytes) !== expected) {
    throw new Error(`SHA-256 mismatch: ${description}`);
  }
}

// Intentionally supports just one exact, hash-pinned hunk, never fuzzy matching.
export function applyPinnedPatch(sourceBytes, patch, pin) {
  assertDigest(sourceBytes, pin.beforeSha256, "original pipe.c");
  assertDigest(patch, pin.sha256, "upstream runtime patch");
  const lines = patch.toString("utf8").split("\n");
  const header = [
    `diff --git a/${pin.target} b/${pin.target}`,
    `--- a/${pin.target}`,
    `+++ b/${pin.target}`,
  ];
  const hunk = /^@@ -\d+,(\d+) \+\d+,(\d+) @@/.exec(lines[3]);
  if (
    !header.every((line, index) => line === lines[index]) ||
    !hunk ||
    lines.pop() !== ""
  ) {
    throw new Error("Expected one LF-terminated runtime-only patch");
  }
  const body = lines.slice(4);
  if (!body.every((line) => /^[ +\-]/.test(line))) {
    throw new Error("Unexpected extra file, hunk, or patch metadata");
  }
  const before = body
    .filter((line) => line[0] !== "+")
    .map((line) => line.slice(1));
  const after = body
    .filter((line) => line[0] !== "-")
    .map((line) => line.slice(1));
  if (before.length !== Number(hunk[1]) || after.length !== Number(hunk[2])) {
    throw new Error("Patch line counts do not match");
  }
  const original = sourceBytes.toString("utf8");
  const oldText = `${before.join("\n")}\n`;
  const index = original.indexOf(oldText);
  if (index < 0 || original.indexOf(oldText, index + 1) >= 0) {
    throw new Error("Patch context must match exactly once");
  }
  const result = Buffer.from(
    original.slice(0, index) +
      `${after.join("\n")}\n` +
      original.slice(index + oldText.length),
  );
  assertDigest(result, pin.afterSha256, "patched pipe.c");
  return result;
}

export function assertArchivePaths(listing, topDirectory) {
  const entries = listing.split(/\r?\n/).filter(Boolean);
  if (!entries.length) throw new Error("Empty archive");
  for (const entry of entries) {
    const path = entry.replace(/\/$/, "");
    if (
      (path !== topDirectory && !path.startsWith(`${topDirectory}/`)) ||
      /[\\:\x00-\x1f]/.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`Archive entry escapes its expected directory: ${entry}`);
    }
  }
}

export function assertBuildPath(directory) {
  // Upstream documents that spaces/non-ASCII paths fail. Keep the isolated root short.
  if (
    !/^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$/.test(directory) ||
    directory.length > 80 ||
    win32.normalize(directory) !== directory ||
    win32.dirname(directory) === directory ||
    directory
      .slice(3)
      .split("\\")
      .some(
        (part) =>
          !part ||
          part.endsWith(".") ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  ) {
    throw new Error(
      "Use a fresh absolute Windows build path, at most 80 ASCII characters, without spaces or dot segments",
    );
  }
}

async function assertPlainAncestors(directory) {
  let path = directory;
  while (true) {
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(path)).toLowerCase() !== resolve(path).toLowerCase()
    ) {
      throw new Error(
        "Build parent must be an existing plain directory without junctions",
      );
    }
    const parent = dirname(path);
    if (parent === path) break;
    path = parent;
  }
}

async function downloadPinned(source, directory) {
  const response = await fetch(source.url, {
    redirect: "error",
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok || !response.body)
    throw new Error(`Download failed: ${source.url} (${response.status})`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 128 * 1024 * 1024)
      throw new Error("Pinned archive exceeded 128 MiB download limit");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  assertDigest(bytes, source.sha256, source.url);
  const archive = join(
    directory,
    new URL(source.url).pathname.split("/").pop(),
  );
  await writeFile(archive, bytes, { flag: "wx" });
  return archive;
}

const tar = () => join(process.env.SystemRoot, "System32", "tar.exe");
const run = (command, args, cwd, timeout = 120_000) =>
  execFileSync(command, args, {
    cwd,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
  });

async function prepare(directory) {
  assertBuildPath(directory);
  await assertPlainAncestors(dirname(directory));
  const dirty = run(
    "git",
    [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      "scripts/release/node-lpac",
    ],
    repository,
  ).trim();
  if (dirty)
    throw new Error("Commit the reviewed recipe before preparing a candidate");
  const recipeCommit = run(
    "git",
    ["rev-parse", "--verify", "HEAD"],
    repository,
  ).trim();
  assertDigest(patchBytes, recipe.patch.sha256, "upstream runtime patch");
  await mkdir(directory); // Fails if it exists; no reuse, deletion, or cleanup of other work.
  const sourceArchive = await downloadPinned(recipe.source, directory);
  const distributionArchive = await downloadPinned(
    recipe.distribution,
    directory,
  );
  for (const [archive, source] of [
    [sourceArchive, recipe.source],
    [distributionArchive, recipe.distribution],
  ]) {
    assertArchivePaths(
      run(tar(), ["-tf", archive], directory),
      source.directory,
    );
    run(tar(), ["-xf", archive, "-C", directory], directory);
  }
  const target = join(directory, recipe.source.directory, recipe.patch.target);
  await writeFile(
    target,
    applyPinnedPatch(await readFile(target), patchBytes, recipe.patch),
  );
  const scripts = {};
  for (const name of recipeInputs) {
    scripts[name] = sha256(await readFile(join(here, name)));
  }
  await writeFile(
    join(directory, "preparation.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        recipeCommit,
        recipeSha256: sha256(recipeBytes),
        scripts,
        candidate: recipe.candidate,
        preparedAt: new Date().toISOString(),
        officialFiles: await inventory(
          join(directory, recipe.distribution.directory),
        ),
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  console.log(`Prepared ${recipe.candidate}; compilation has not run.`);
}

export async function inventory(directory, prefix = "") {
  const files = {};
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))
    ) {
      throw new Error(
        `Candidate contains a link or non-regular file: ${prefix}${name}`,
      );
    }
    if (info.isDirectory())
      Object.assign(files, await inventory(path, `${prefix}${name}/`));
    else files[`${prefix}${name}`] = sha256(await readFile(path));
  }
  return files;
}

export function assertPayloadPreserved(official, candidate, executableHash) {
  const expected = { ...official, "node.exe": executableHash };
  if (
    JSON.stringify(Object.entries(expected).sort()) !==
    JSON.stringify(Object.entries(candidate).sort())
  ) {
    throw new Error(
      "Candidate must preserve every official file except node.exe",
    );
  }
}

export function assertRuntimeIdentity(observed) {
  if (
    observed.node !== recipe.version ||
    observed.uv !== recipe.libuvVersion ||
    observed.arch !== "x64" ||
    observed.platform !== "win32"
  ) {
    throw new Error(
      "Compiled runtime identity differs from the pinned Node/libuv Windows x64 source",
    );
  }
}

async function packageCandidate(directory) {
  assertBuildPath(directory);
  await assertPlainAncestors(directory);
  const prepared = JSON.parse(
    await readFile(join(directory, "preparation.json")),
  );
  assertDigest(recipeBytes, prepared.recipeSha256, "prepared recipe");
  for (const name of recipeInputs) {
    assertDigest(
      await readFile(join(here, name)),
      prepared.scripts[name],
      name,
    );
  }
  const build = JSON.parse(await readFile(join(directory, "build.json")));
  if (
    build.exitCode !== 0 ||
    build.recipeSha256 !== prepared.recipeSha256 ||
    build.command !==
      [recipe.build.command, ...recipe.build.arguments].join(" ") ||
    build.msbuildArguments !== recipe.build.msbuildArguments ||
    build.numberOfProcessors !== 1 ||
    build.priority !== "BelowNormal" ||
    !build.toolchain?.python ||
    !build.toolchain?.nasm ||
    !build.toolchain?.visualStudio
  ) {
    throw new Error("A successful recorded build and toolchain are required");
  }
  const source = join(directory, recipe.source.directory);
  assertDigest(
    await readFile(join(source, recipe.patch.target)),
    recipe.patch.afterSha256,
    "built pipe.c",
  );
  const executable = join(source, "out", "Release", "node.exe");
  const executableHash = sha256(await readFile(executable));
  const observed = JSON.parse(
    run(
      executable,
      [
        "-p",
        "JSON.stringify({node:process.versions.node,uv:process.versions.uv,arch:process.arch,platform:process.platform})",
      ],
      source,
      10_000,
    ),
  );
  assertRuntimeIdentity(observed);
  const official = join(directory, recipe.distribution.directory);
  const officialFiles = await inventory(official);
  assertPayloadPreserved(
    prepared.officialFiles,
    officialFiles,
    prepared.officialFiles["node.exe"],
  );
  const artifact = join(directory, "artifact");
  await mkdir(artifact);
  const payload = join(artifact, recipe.candidate);
  await cp(official, payload, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await copyFile(executable, join(payload, "node.exe"));
  const files = await inventory(payload);
  assertPayloadPreserved(officialFiles, files, executableHash);
  for (const name of ["recipe.json", recipe.patch.file, "LICENSE.libuv"])
    await copyFile(join(here, name), join(artifact, name));
  await copyFile(join(directory, "build.json"), join(artifact, "build.json"));
  const provenance = {
    schemaVersion: 1,
    candidate: recipe.candidate,
    prepared,
    recipe,
    build,
    runtime: observed,
    files,
    signed: false,
    publication: "not-published",
    productionPromotion: "not-approved",
    evidence: {
      hostVersionSmoke: "passed",
      directWin32PipeProbe: "pending",
      lpacAcceptance: "pending",
      packagedApp: "pending",
    },
    reproducibility:
      "Pinned source and recorded toolchain; byte-for-byte reproducibility has not been demonstrated",
  };
  await writeFile(
    join(artifact, "provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  await writeFile(
    join(artifact, "MIVLET-BACKPORT.txt"),
    [
      `${recipe.candidate}: unsigned Mivlet validation candidate, not an official Node binary.`,
      `Node source commit: ${recipe.nodeCommit}; libuv runtime backport: ${recipe.patch.upstreamCommit}.`,
      "Only deps/uv/src/win/pipe.c is patched; the upstream AppContainer harness is excluded.",
      "The original Node LICENSE (including libuv notices) is retained in the payload.",
      "This archive is not a production trust anchor or evidence of LPAC acceptance.",
      "",
    ].join("\n"),
  );
  const archive = join(directory, `${recipe.candidate}.zip`);
  // The root is freshly owned and the artifact directory was created exclusively above.
  run(
    tar(),
    [
      "-a",
      "-cf",
      archive,
      "-C",
      artifact,
      recipe.candidate,
      "provenance.json",
      "recipe.json",
      recipe.patch.file,
      "LICENSE.libuv",
      "build.json",
      "MIVLET-BACKPORT.txt",
    ],
    directory,
  );
  const receipt = {
    candidate: recipe.candidate,
    archive: `${recipe.candidate}.zip`,
    sha256: sha256(await readFile(archive)),
    executableSha256: executableHash,
  };
  await writeFile(
    join(directory, "artifact-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: "wx" },
  );
  console.log(JSON.stringify(receipt, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [action = "--plan", directory, ...extra] = process.argv.slice(2);
  if (
    extra.length ||
    !["--plan", "--prepare", "--package"].includes(action) ||
    (action !== "--plan" && !directory) ||
    (action === "--plan" && directory)
  ) {
    throw new Error(
      "Usage: candidate.mjs [--plan | --prepare FRESH_DIRECTORY | --package PREPARED_DIRECTORY]",
    );
  }
  if (action === "--plan")
    console.log(
      JSON.stringify(
        {
          ...recipe,
          status: "candidate-recipe-only; native build and acceptance pending",
        },
        null,
        2,
      ),
    );
  else {
    if (process.platform !== "win32" || process.arch !== "x64")
      throw new Error(
        "Candidate preparation and packaging require Windows x64",
      );
    if (action === "--prepare") await prepare(directory);
    else await packageCandidate(directory);
  }
}

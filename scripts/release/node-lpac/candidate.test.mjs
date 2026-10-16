import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  applyPinnedPatch,
  assertArchivePaths,
  assertBuildPath,
  assertDigest,
  assertPayloadPreserved,
  assertRuntimeIdentity,
  inventory,
  sha256,
} from "./candidate.mjs";

const recipe = JSON.parse(
  await readFile(new URL("./recipe.json", import.meta.url)),
);
const patch = await readFile(new URL(recipe.patch.file, import.meta.url));

// Small context fixture exercises the real runtime hunk without vendoring pipe.c.
const original = Buffer.from(
  [
    "/* fixture */",
    "}",
    "",
    "",
    "static void uv__unique_pipe_name(unsigned long long ptr, char* name, size_t size) {",
    '  snprintf(name, size, "\\\\\\\\?\\\\pipe\\\\uv\\\\%llu-%lu", ptr, GetCurrentProcessId());',
    "}",
    "",
    "",
    "/* fixture end */",
    "",
  ].join("\n"),
);
const after = Buffer.from(
  [
    "/* fixture */",
    "}",
    "",
    "",
    "static int uv_is_app_container_;",
    "static uv_once_t uv_is_app_container_guard_ = UV_ONCE_INIT;",
    "",
    "",
    "/* Is this process running under Windows AppContainer? */",
    "/* Detection algorithm from https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-for-legacy-applications- */",
    "static void uv__init__is_app_container(void) {",
    "  HANDLE token;",
    "  DWORD ac;",
    "  DWORD len;",
    "  int ok;",
    "",
    "  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {",
    "    uv_is_app_container_ = 0;",
    "    return;",
    "  }",
    "  ac = 0;",
    "  len = sizeof(ac);",
    "  ok = GetTokenInformation(token, TokenIsAppContainer, &ac, len, &len);",
    "  CloseHandle(token);",
    "  uv_is_app_container_ = ok && ac != 0;",
    "}",
    "",
    "",
    "/* Is this process running under Windows AppContainer? */",
    "/* Cached form for repeated use in the process. */",
    "static int uv__is_appcontainer(void) {",
    "  uv_once(&uv_is_app_container_guard_, uv__init__is_app_container);",
    "  return uv_is_app_container_;",
    "}",
    "",
    "",
    "static void uv__unique_pipe_name(unsigned long long ptr, char* name, size_t size) {",
    '  snprintf(name, size, "\\\\\\\\?\\\\pipe\\\\%suv\\\\%llu-%lu",',
    '           uv__is_appcontainer() ? "LOCAL\\\\" : "",',
    "           ptr, GetCurrentProcessId());",
    "}",
    "",
    "",
    "/* fixture end */",
    "",
  ].join("\n"),
);
const fixturePin = {
  ...recipe.patch,
  beforeSha256: sha256(original),
  afterSha256: sha256(after),
};

test("the one upstream runtime hunk applies exactly and preserves surrounding bytes", () => {
  assert.deepEqual(applyPinnedPatch(original, patch, fixturePin), after);
  assertDigest(patch, recipe.patch.sha256, "checked-in runtime patch");
  assert.throws(
    () => applyPinnedPatch(after, patch, fixturePin),
    /original pipe.c/,
  );
});

test("refuses changed source, patch, or expected after-image before accepting output", () => {
  assert.throws(
    () =>
      applyPinnedPatch(
        Buffer.concat([original, Buffer.from("changed")]),
        patch,
        fixturePin,
      ),
    /original pipe.c/,
  );
  assert.throws(
    () =>
      applyPinnedPatch(
        original,
        Buffer.concat([patch, Buffer.from("changed")]),
        fixturePin,
      ),
    /runtime patch/,
  );
  assert.throws(
    () =>
      applyPinnedPatch(original, patch, {
        ...fixturePin,
        afterSha256: "0".repeat(64),
      }),
    /patched pipe.c/,
  );
});

test("refuses fuzzy context, duplicate context and extra hunks even if their input hash is updated", () => {
  const changed = Buffer.from(
    original.toString().replace("GetCurrentProcessId()", "different()"),
  );
  assert.throws(
    () =>
      applyPinnedPatch(changed, patch, {
        ...fixturePin,
        beforeSha256: sha256(changed),
      }),
    /exactly once/,
  );
  const duplicate = Buffer.concat([original, original]);
  assert.throws(
    () =>
      applyPinnedPatch(duplicate, patch, {
        ...fixturePin,
        beforeSha256: sha256(duplicate),
      }),
    /exactly once/,
  );
  const extra = Buffer.concat([
    patch,
    Buffer.from("@@ -1,1 +1,1 @@\n-x\n+y\n"),
  ]);
  assert.throws(
    () =>
      applyPinnedPatch(original, extra, {
        ...fixturePin,
        sha256: sha256(extra),
      }),
    /extra file, hunk/,
  );
});

test("refuses a different target file or incorrect patch counts", () => {
  const wrongTarget = Buffer.from(
    patch.toString().replaceAll(recipe.patch.target, "test/runner.c"),
  );
  assert.throws(
    () =>
      applyPinnedPatch(original, wrongTarget, {
        ...fixturePin,
        sha256: sha256(wrongTarget),
      }),
    /runtime-only/,
  );
  const wrongCount = Buffer.from(patch.toString().replace("-106,8", "-106,9"));
  assert.throws(
    () =>
      applyPinnedPatch(original, wrongCount, {
        ...fixturePin,
        sha256: sha256(wrongCount),
      }),
    /line counts/,
  );
});

test("archive inventory accepts only the expected top directory and its descendants", () => {
  assertArchivePaths("node-v1/\nnode-v1/deps/uv/pipe.c\n", "node-v1");
  for (const path of [
    "",
    "elsewhere/file",
    "node-v10/file",
    "/node-v1/file",
    "node-v1/../escape",
    "node-v1/./file",
    "node-v1//file",
    "node-v1/file:stream",
    "node-v1/a\\b",
  ]) {
    assert.throws(() => assertArchivePaths(path, "node-v1"), /archive|Archive/);
  }
});

test("requires a short, unambiguous Windows build path", () => {
  assertBuildPath("C:\\MivletBuilds\\node-lpac1");
  for (const path of [
    ".",
    "C:\\",
    "C:relative",
    "\\\\server\\share\\build",
    "C:\\Users\\Name Surname\\build",
    "C:\\ümlaut",
    "C:\\foo\\..\\bar",
    "C:\\CON",
    "C:\\foo.\\bar",
    "C:\\build\\",
  ]) {
    assert.throws(() => assertBuildPath(path), /build path/);
  }
});

test("packaging preserves the complete official payload except the compiled node.exe", () => {
  const official = {
    "node.exe": "old",
    LICENSE: "license",
    "node_modules/npm/bin/npm-cli.js": "npm",
  };
  const expected = { ...official, "node.exe": "compiled" };
  assertPayloadPreserved(official, expected, "compiled");
  for (const changed of [
    { ...expected, LICENSE: "changed" },
    { "node.exe": "compiled", LICENSE: "license" },
    { ...expected, "extra.exe": "unreviewed" },
    official,
  ])
    assert.throws(
      () => assertPayloadPreserved(official, changed, "compiled"),
      /preserve every official file/,
    );
});

test("inventory hashes nested payloads and rejects hard links", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mivlet-node-inventory-"));
  // Only remove the exact fresh test directory, never a build root or shared cache.
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(basename(directory), /^mivlet-node-inventory-[A-Za-z0-9]+$/);
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(join(directory, "npm"));
  await writeFile(join(directory, "npm", "cli.js"), "npm");
  assert.deepEqual(await inventory(directory), { "npm/cli.js": sha256("npm") });
  await link(join(directory, "npm", "cli.js"), join(directory, "linked.js"));
  await assert.rejects(inventory(directory), /link or non-regular file/);
});

test("host smoke must match the pinned Node, libuv, OS and architecture", () => {
  const expected = {
    node: recipe.version,
    uv: recipe.libuvVersion,
    arch: "x64",
    platform: "win32",
  };
  assertRuntimeIdentity(expected);
  for (const key of Object.keys(expected))
    assert.throws(
      () => assertRuntimeIdentity({ ...expected, [key]: "other" }),
      /runtime identity/,
    );
});

test("default invocation produces only the pending candidate plan", () => {
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("./candidate.mjs", import.meta.url))],
    { encoding: "utf8", timeout: 10_000, windowsHide: true },
  );
  const plan = JSON.parse(output);
  assert.equal(plan.candidate, recipe.candidate);
  assert.equal(
    plan.status,
    "candidate-recipe-only; native build and acceptance pending",
  );
});

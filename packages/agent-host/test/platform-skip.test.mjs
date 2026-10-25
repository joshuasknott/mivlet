import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  WINDOWS_HOST_SKIP_REASON,
  executable,
  hostExecutableFor,
  windowsHostMissingReason,
  windowsHostSkipOptions,
  windowsHostSkipReason,
} from "./support/windows-host.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testDirectory, "..");
const fixture = join(testDirectory, "support", "windows-host-skip.fixture.mjs");

function hostTestFiles() {
  return readdirSync(testDirectory)
    .filter((name) => name.endsWith(".test.mjs") && !["platform-skip.test.mjs", "platform.test.mjs"].includes(name))
    .sort();
}

function runNodeTest(files) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ["--test", "--test-reporter", "tap", ...files], {
    cwd: packageRoot,
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
}

test("win32 skip options leave host tests enabled when the binary is present", () => {
  assert.deepEqual(windowsHostSkipOptions({ platform: "win32", present: true }), {});
  assert.equal(windowsHostSkipReason({ platform: "win32", present: true }), null);
});

test("win32 skip options skip when the bundled binary is missing", () => {
  assert.deepEqual(windowsHostSkipOptions({ platform: "win32", present: false }), {
    skip: windowsHostMissingReason(hostExecutableFor("win32")),
  });
});

test("linux host options run when the native binary is present", () => {
  assert.deepEqual(windowsHostSkipOptions({ platform: "linux", present: true }), {});
  assert.equal(windowsHostSkipReason({ platform: "linux", present: true }), null);
});

test("unsupported platforms skip even when a binary is present", () => {
  for (const platform of ["darwin", "freebsd", "android", "aix", "openbsd"]) {
    assert.deepEqual(windowsHostSkipOptions({ platform, present: true }), { skip: WINDOWS_HOST_SKIP_REASON });
  }
});

test("live skip options match platform and binary presence", () => {
  assert.deepEqual(
    windowsHostSkipOptions(),
    windowsHostSkipOptions({ platform: process.platform, present: existsSync(executable) }),
  );
  if (["win32", "linux"].includes(process.platform) && existsSync(executable)) {
    assert.deepEqual(windowsHostSkipOptions(), {});
  } else if (!["win32", "linux"].includes(process.platform)) {
    assert.equal(windowsHostSkipOptions().skip, WINDOWS_HOST_SKIP_REASON);
  } else {
    assert.equal(windowsHostSkipOptions().skip, windowsHostMissingReason());
  }
});

test("every bundled-executable test file uses the shared Windows skip", () => {
  const files = hostTestFiles();
  assert.ok(files.length > 0, "expected host test files");
  for (const name of files) {
    const source = readFileSync(join(testDirectory, name), "utf8");
    assert.match(
      source,
      /import \{[^}]*\btest\b[^}]*\} from "\.\/support\/windows-host\.mjs"/,
      `${name} must register tests through the Windows skip helper`,
    );
    assert.doesNotMatch(
      source,
      /import \{[^}]*\btest\b[^}]*\} from "node:test"/,
      `${name} must not register tests with node:test directly`,
    );
  }
});

test("unsupported platform options prevent the test body from running", windowsHostSkipOptions({ platform: "darwin", present: true }), () => {
  throw new Error("unsupported platform options must prevent execution");
});

test("AgentHostProcess refuses to spawn when the host is skipped", {
  skip: ["win32", "linux"].includes(process.platform) && existsSync(executable) ? `${process.platform} with a built host may spawn` : false,
}, async () => {
  const { AgentHostProcess } = await import("./support/host-process.mjs");
  assert.throws(() => new AgentHostProcess(), { message: windowsHostSkipReason() });
});

test("node:test skips unsupported and missing-binary options", () => {
  const result = runNodeTest([fixture]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /# SKIP the bundled agent host is unsupported on this platform/);
  assert.match(output, /# SKIP bundled agent host is missing:/);
  assert.match(output, /# skipped 2/);
  assert.match(output, /# fail 0/);
  assert.match(output, /# pass 2/);
  assert.doesNotMatch(output, /^not ok /m);
  assert.doesNotMatch(output, /unsupported platform options must prevent execution/);
  assert.doesNotMatch(output, /missing binary skip options must prevent execution/);
});

test("bundled host tests skip instead of spawning on unsupported platforms", {
  skip: ["win32", "linux"].includes(process.platform) ? `${process.platform} runs the bundled executable tests directly` : false,
}, () => {
  const files = hostTestFiles().map((name) => join("test", name));
  const result = runNodeTest(files);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /# SKIP the bundled agent host is unsupported on this platform/);
  assert.doesNotMatch(output, /^not ok /m);
  assert.doesNotMatch(output, /ENOENT/);
  const skipped = output.match(/# skipped (\d+)/);
  assert.ok(skipped, output);
  assert.ok(Number(skipped[1]) >= files.length, output);
});

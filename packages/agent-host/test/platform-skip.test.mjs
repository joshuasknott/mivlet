import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  WINDOWS_HOST_SKIP_REASON,
  windowsHostSkipOptions,
} from "./support/windows-host.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testDirectory, "..");
const fixture = join(testDirectory, "support", "windows-host-skip.fixture.mjs");

function hostTestFiles() {
  return readdirSync(testDirectory)
    .filter((name) => name.endsWith(".test.mjs") && name !== "platform-skip.test.mjs")
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

test("win32 skip options leave host tests enabled", () => {
  assert.deepEqual(windowsHostSkipOptions("win32"), {});
});

test("non-Windows platforms skip the bundled executable tests", () => {
  for (const platform of ["linux", "darwin", "freebsd", "android", "aix", "openbsd"]) {
    assert.deepEqual(windowsHostSkipOptions(platform), { skip: WINDOWS_HOST_SKIP_REASON });
  }
});

test("current platform skip options match process.platform", () => {
  assert.deepEqual(windowsHostSkipOptions(), windowsHostSkipOptions(process.platform));
  if (process.platform === "win32") {
    assert.deepEqual(windowsHostSkipOptions(), {});
  } else {
    assert.equal(windowsHostSkipOptions().skip, WINDOWS_HOST_SKIP_REASON);
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

test("linux skip options prevent the test body from running", windowsHostSkipOptions("linux"), () => {
  throw new Error("linux skip options must prevent execution");
});

test("AgentHostProcess refuses to spawn the Windows executable off win32", {
  skip: process.platform === "win32" ? "Windows is allowed to spawn the host" : false,
}, async () => {
  const { AgentHostProcess } = await import("./support/host-process.mjs");
  assert.throws(() => new AgentHostProcess(), { message: WINDOWS_HOST_SKIP_REASON });
});

test("node:test skips linux options and still runs win32 options", () => {
  const result = runNodeTest([fixture]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /# SKIP the acceptance host is the bundled Windows executable/);
  assert.match(output, /# skipped 1/);
  assert.match(output, /# fail 0/);
  assert.match(output, /# pass 1/);
  assert.doesNotMatch(output, /^not ok /m);
  assert.doesNotMatch(output, /linux skip options must prevent execution/);
});

test("bundled host tests skip instead of spawning the Windows executable off win32", {
  skip: process.platform === "win32" ? "Windows runs the bundled executable tests directly" : false,
}, () => {
  const files = hostTestFiles().map((name) => join("test", name));
  const result = runNodeTest(files);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /# SKIP the acceptance host is the bundled Windows executable/);
  assert.doesNotMatch(output, /^not ok /m);
  assert.doesNotMatch(output, /ENOENT/);
  assert.doesNotMatch(output, /mivlet-agent-host\.exe/);
  const skipped = output.match(/# skipped (\d+)/);
  assert.ok(skipped, output);
  assert.ok(Number(skipped[1]) >= files.length, output);
});

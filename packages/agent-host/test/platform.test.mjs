import assert from "node:assert/strict";
import test from "node:test";
import { agentHostPlatform } from "../scripts/platform.mjs";

test("agent host selects the Windows x64 target and executable", () => {
  assert.deepEqual(agentHostPlatform("win32", "x64"), {
    platform: "win32",
    architecture: "x64",
    target: "bun-windows-x64",
    packageName: "@oven/bun-windows-x64",
    bunBinary: "bin/bun.exe",
    binary: "mivlet-agent-host.exe",
  });
});

test("agent host selects the Linux x64 baseline target and executable", () => {
  assert.deepEqual(agentHostPlatform("linux", "x64"), {
    platform: "linux",
    architecture: "x64",
    target: "bun-linux-x64-baseline",
    packageName: "@oven/bun-linux-x64-baseline",
    bunBinary: "bin/bun",
    binary: "mivlet-agent-host",
  });
});

test("agent host refuses unsupported targets", () => {
  assert.throws(() => agentHostPlatform("linux", "arm64"), /supports Windows x64 and Linux x64/);
});

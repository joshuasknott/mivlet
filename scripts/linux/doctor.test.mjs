import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectLinux } from "./doctor.mjs";

const available = (command) => ({ ok: true, output: command === "pnpm" ? "10.34.7" : "available" });

test("a build-only WSL environment does not imply a desktop or usable wallet", () => {
  const calls = [];
  const checks = inspectLinux({ platform: "linux", arch: "x64", node: "22.0.0", run: (...args) => { calls.push(args); return available(...args); } });
  assert.ok(checks.every(check => check.ok));
  assert.ok(!calls.some(([command]) => command === "gdbus"));
  assert.ok(!checks.some(check => check.name === "Secret Service"));
});

test("desktop readiness fails when the session credential service cannot be reached", () => {
  const checks = inspectLinux({ platform: "linux", arch: "x64", node: "24.0.0", desktop: true, session: "wayland", run: (command, args) => command === "gdbus" && args.includes("org.freedesktop.secrets") ? { ok: false } : available(command) });
  assert.equal(checks.find(check => check.name === "Secret Service").ok, false);
  assert.equal(checks.find(check => check.name === "Desktop session").ok, true);
});

test("unsupported architectures, missing native libraries and wrong pnpm fail explicitly", () => {
  const checks = inspectLinux({ platform: "linux", arch: "arm64", node: "20.0.0", run: command => command === "pkg-config" ? { ok: false } : { ok: true, output: "9.0.0" } });
  for (const name of ["Platform", "Node", "pnpm", "webkit2gtk-4.1"]) assert.equal(checks.find(check => check.name === name).ok, false);
});

test("a responding wallet is not described as unlocked or proven persistent", () => {
  const checks = inspectLinux({ platform: "linux", arch: "x64", node: "22.0.0", desktop: true, session: "wayland", run: available });
  assert.match(checks.find(check => check.name === "Secret Service").detail, /must still verify/);
});

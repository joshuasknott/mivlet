import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test as nodeTest } from "node:test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
export function hostExecutableFor(platform = process.platform) {
  const binary = platform === "win32" ? "mivlet-agent-host.exe" : "mivlet-agent-host";
  return resolve(testDirectory, `../../../../apps/desktop/src-tauri/resources/agent-host/${binary}`);
}
export const executable = hostExecutableFor();

export const WINDOWS_HOST_SKIP_REASON = "the bundled agent host is unsupported on this platform";

export function windowsHostMissingReason(path = executable) {
  return `bundled agent host is missing: ${path}`;
}

export function windowsHostSkipReason({
  platform = process.platform,
  architecture = process.arch,
  present = existsSync(hostExecutableFor(platform)),
} = {}) {
  if (architecture !== "x64") return WINDOWS_HOST_SKIP_REASON;
  if (!(["win32", "linux"].includes(platform))) return WINDOWS_HOST_SKIP_REASON;
  if (!present) return windowsHostMissingReason(hostExecutableFor(platform));
  return null;
}

export function windowsHostSkipOptions(overrides = {}) {
  const reason = windowsHostSkipReason(overrides);
  return reason ? { skip: reason } : {};
}

export function test(name, options, fn) {
  if (typeof options === "function") {
    fn = options;
    options = {};
  }
  return nodeTest(name, { ...options, ...windowsHostSkipOptions() }, fn);
}

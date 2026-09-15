import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test as nodeTest } from "node:test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
export const executable = resolve(testDirectory, "../../../../apps/desktop/src-tauri/resources/agent-host/mivlet-agent-host.exe");

export const WINDOWS_HOST_SKIP_REASON = "the acceptance host is the bundled Windows executable";

export function windowsHostMissingReason(path = executable) {
  return `bundled agent host is missing: ${path}`;
}

export function windowsHostSkipReason({
  platform = process.platform,
  present = existsSync(executable),
} = {}) {
  if (platform !== "win32") return WINDOWS_HOST_SKIP_REASON;
  if (!present) return windowsHostMissingReason();
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

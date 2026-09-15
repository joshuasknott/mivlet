import { test as nodeTest } from "node:test";

export const WINDOWS_HOST_SKIP_REASON = "the acceptance host is the bundled Windows executable";

export function windowsHostSkipOptions(platform = process.platform) {
  return platform === "win32" ? {} : { skip: WINDOWS_HOST_SKIP_REASON };
}

export function test(name, options, fn) {
  if (typeof options === "function") {
    fn = options;
    options = {};
  }
  return nodeTest(name, { ...options, ...windowsHostSkipOptions() }, fn);
}

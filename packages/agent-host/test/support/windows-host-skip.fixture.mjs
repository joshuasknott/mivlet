import { test } from "node:test";
import { windowsHostSkipOptions } from "./windows-host.mjs";

test("runs with linux skip options when the binary is present", windowsHostSkipOptions({ platform: "linux", present: true }), () => {
});

test("does not run with unsupported platform options", windowsHostSkipOptions({ platform: "darwin", present: true }), () => {
  throw new Error("unsupported platform options must prevent execution");
});

test("runs with win32 skip options when the binary is present", windowsHostSkipOptions({ platform: "win32", present: true }), () => {});

test("does not run when the bundled binary is missing", windowsHostSkipOptions({ platform: "win32", present: false }), () => {
  throw new Error("missing binary skip options must prevent execution");
});

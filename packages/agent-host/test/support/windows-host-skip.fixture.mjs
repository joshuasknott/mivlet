import { test } from "node:test";
import { windowsHostSkipOptions } from "./windows-host.mjs";

test("does not run with linux skip options", windowsHostSkipOptions("linux"), () => {
  throw new Error("linux skip options must prevent execution");
});

test("runs with win32 skip options", windowsHostSkipOptions("win32"), () => {});

import "./prepare-cua-driver.mjs";
import "./prepare-execution-runtime.mjs";
import "../../../packages/agent-host/scripts/build.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { publicBuildEnvironment } from "./public-build-env.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localPath = resolve(desktopRoot, ".env.local");
const local = existsSync(localPath) ? parseEnv(readFileSync(localPath, "utf8")) : {};
const environment = publicBuildEnvironment(process.env, local);
const result = spawnSync(process.execPath, [
  resolve(desktopRoot, "node_modules/@tauri-apps/cli/tauri.js"),
  "build",
  ...process.argv.slice(2),
], { cwd: desktopRoot, env: environment, stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

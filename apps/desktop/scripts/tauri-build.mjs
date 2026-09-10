import "./prepare-cua-driver.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localPath = resolve(desktopRoot, ".env.local");
const local = existsSync(localPath) ? parseEnv(readFileSync(localPath, "utf8")) : {};
const environment = { ...process.env };
// Only public account and connector configuration is compiled into the native application.
for (const key of [
  "FABLE_GOOGLE_OAUTH_CLIENT_ID",
  "FABLE_AUTH_BROKER_URL",
  "FABLE_CLERK_ISSUER",
  "FABLE_CLERK_OAUTH_CLIENT_ID",
  "FABLE_CLERK_AUDIENCE",
  "FABLE_CLERK_AUTHORIZED_PARTY",
  "FABLE_CLERK_SCOPES",
]) {
  if (Object.hasOwn(local, key)) environment[key] = local[key];
}
const result = spawnSync(process.execPath, [
  resolve(desktopRoot, "node_modules/@tauri-apps/cli/tauri.js"),
  "build",
  ...process.argv.slice(2),
], { cwd: desktopRoot, env: environment, stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

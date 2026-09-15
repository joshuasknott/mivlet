import "./prepare-cua-driver.mjs";
import "../../../packages/agent-host/scripts/build.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localPath = resolve(desktopRoot, ".env.local");
const local = existsSync(localPath) ? parseEnv(readFileSync(localPath, "utf8")) : {};
const environment = { ...process.env };
const packagedKeys = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "AUTH_BROKER_URL",
  "CLERK_ISSUER",
  "CLERK_OAUTH_CLIENT_ID",
  "CLERK_AUDIENCE",
  "CLERK_AUTHORIZED_PARTY",
  "CLERK_SCOPES",
];
for (const suffix of packagedKeys) {
  const current = `MIVLET_${suffix}`;
  const legacy = `FABLE_${suffix}`;
  if (Object.hasOwn(local, current)) environment[current] = local[current];
  else if (Object.hasOwn(local, legacy)) environment[current] = local[legacy];
  if (Object.hasOwn(local, legacy)) environment[legacy] = local[legacy];
}
const result = spawnSync(process.execPath, [
  resolve(desktopRoot, "node_modules/@tauri-apps/cli/tauri.js"),
  "build",
  ...process.argv.slice(2),
], { cwd: desktopRoot, env: environment, stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * Apply the desktop's ignored local environment deterministically.
 *
 * Node's process.loadEnvFile() preserves inherited values. That is surprising
 * for a development-only .env.local file and can leave Mivlet using stale OAuth
 * configuration from the parent process. Explicit assignment makes the local
 * file authoritative without logging or otherwise exposing any values.
 */
export function applyLocalEnvironment(path, environment = process.env) {
  if (!existsSync(path)) {
    return [];
  }

  const entries = parseEnv(readFileSync(path, "utf8"));
  for (const [key, value] of Object.entries(entries)) {
    environment[key] = value;
  }
  return Object.keys(entries).sort();
}

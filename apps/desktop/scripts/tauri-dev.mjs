import "./prepare-cua-driver.mjs";
import "../../../packages/agent-host/scripts/build.mjs";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

import { applyLocalEnvironment } from "./local-env.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localEnvironmentPath = resolve(desktopRoot, ".env.local");
const tauriEntrypoint = resolve(
  desktopRoot,
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js",
);

if (existsSync(localEnvironmentPath)) {
  applyLocalEnvironment(localEnvironmentPath);
}

if (!existsSync(tauriEntrypoint)) {
  throw new Error(
    "The Tauri CLI is unavailable. Install the frozen workspace dependencies first.",
  );
}

// Own Vite in this session, not in the CLI's beforeDevCommand child tree.
// Tauri restarts the native process after account changes; the CLI observing
// the outgoing process exit must not take the restarted app's UI server down.
const server = await createServer({
  root: desktopRoot,
  configLoader: "runner",
  server: { host: "127.0.0.1" },
});
await server.listen();
// Keep browser account entry alive across native account/process restarts.
const accountsRoot = resolve(desktopRoot, "../accounts");
let accountsServer;
if (existsSync(resolve(accountsRoot, ".env.local"))) {
  accountsServer = await createServer({
    root: accountsRoot,
    configFile: resolve(accountsRoot, "vite.config.ts"),
    configLoader: "runner",
    server: { host: "127.0.0.1", port: 1421, strictPort: true },
  });
  try {
    await accountsServer.listen();
  } catch (error) {
    await accountsServer.close();
    await server.close();
    throw error;
  }
  if (!process.env.MIVLET_CLERK_ACCOUNT_ENTRY_URL?.trim()) {
    process.env.MIVLET_CLERK_ACCOUNT_ENTRY_URL =
      "http://127.0.0.1:1421/desktop/start";
  }
}
const config = JSON.parse(
  readFileSync(resolve(desktopRoot, "src-tauri/tauri.dev.conf.json"), "utf8"),
);
config.build = { ...config.build, beforeDevCommand: "" };
const child = spawn(
  process.execPath,
  [tauriEntrypoint, "dev", "--config", JSON.stringify(config)],
  {
    cwd: desktopRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (!child.killed) {
      child.kill(signal);
    }
    await server.close();
    await accountsServer?.close();
  });
}

child.on("error", async (error) => {
  console.error(
    `Mivlet could not start the Tauri development process: ${error.message}`,
  );
  process.exitCode = 1;
  await server.close();
  await accountsServer?.close();
});

child.on("exit", async (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
  if (code !== 0) {
    await server.close();
    await accountsServer?.close();
  } else
    console.info(
      "Mivlet UI server remains available for account restarts. Stop this development session with Ctrl+C.",
    );
});

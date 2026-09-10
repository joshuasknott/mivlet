import "./prepare-cua-driver.mjs";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const child = spawn(
  process.execPath,
  [tauriEntrypoint, "dev", "--config", "src-tauri/tauri.dev.conf.json"],
  {
    cwd: desktopRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

child.on("error", (error) => {
  console.error(`Mivlet could not start the Tauri development process: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});

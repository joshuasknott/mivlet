import "../../../packages/agent-host/scripts/build.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { publicBuildEnvironment } from "./public-build-env.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform === "win32" && process.arch === "x64") {
  await import("./prepare-cua-driver.mjs");
  await import("./prepare-execution-runtime.mjs");
}
const localPath = resolve(desktopRoot, ".env.local");
const local = existsSync(localPath) ? parseEnv(readFileSync(localPath, "utf8")) : {};
const environment = publicBuildEnvironment(process.env, local);
const cliArgs = [
  resolve(desktopRoot, "node_modules/@tauri-apps/cli/tauri.js"),
  "build",
  ...process.argv.slice(2),
];
if (process.platform === "linux" && process.arch === "x64") {
  cliArgs.push("--config", JSON.stringify({
    bundle: {
      icon: ["icons/icon.png", "icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png"],
      resources: [
        "resources/agent-host/**/*",
        "resources/pdfjs-notices/**/*",
        "resources/pdf-fonts/README.md",
      ],
    },
  }));
}
const result = spawnSync(process.execPath, cliArgs, { cwd: desktopRoot, env: environment, stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

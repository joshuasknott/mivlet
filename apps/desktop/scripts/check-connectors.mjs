import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyLocalEnvironment } from "./local-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
applyLocalEnvironment(resolve(root, ".env.local"));
const chat = process.argv.includes("--chat");
const connectIndex = process.argv.indexOf("--connect");
const connectArgs = connectIndex >= 0 ? ["--connect", process.argv[connectIndex + 1] ?? ""] : [];
const child = spawn(resolve(root, "src-tauri/target/debug/mivlet-desktop.exe"), ["--check-connectors", ...(chat ? ["--chat"] : []), ...connectArgs], {
  cwd: root, env: process.env, stdio: [chat ? "pipe" : "ignore", "inherit", "inherit"], windowsHide: true,
});
if (chat) {
  const { registeredToolSpecs } = await import("../../../packages/connectors/dist/native-api/tools.js");
  const modelIndex = process.argv.indexOf("--model");
  if (modelIndex < 0 || !process.argv[modelIndex + 1]) { child.kill(); throw new Error("Choose the connected model with --model."); }
  child.stdin.end(JSON.stringify({ model: process.argv[modelIndex + 1], tools: registeredToolSpecs() }));
}
child.on("error", () => { console.error("Build the native desktop binary before checking connectors."); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });

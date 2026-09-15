import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const bun = resolve(dirname(require.resolve("@oven/bun-windows-x64/package.json")), "bin/bun.exe");
const destination = resolve(root, "../../apps/desktop/src-tauri/resources/agent-host");
mkdirSync(destination, { recursive: true });
// Preserve redistribution notices from the exact installed dependency graph.
const visited = new Set();
const notices = [];
function collect(directory) {
  directory = realpathSync(directory);
  if (visited.has(directory)) return;
  visited.add(directory);
  const pkg = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
  notices.push(`${pkg.name}@${pkg.version}\nLicense: ${JSON.stringify(pkg.license ?? "See upstream source")}\nSource: ${JSON.stringify(pkg.repository ?? pkg.homepage ?? "npm registry")}\n`);
  for (const name of readdirSync(directory).filter(name => /^(license|licence|copying|notice)(\.|$)/i.test(name))) {
    const content = readFileSync(resolve(directory, name), "utf8");
    notices.push(content);
  }
  if (pkg.name.startsWith("@opencode/")) notices.push(readFileSync(resolve(destination, "LICENSE-OpenCode.txt"), "utf8"));
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (name === "@mivlet/protocol") continue;
    let ancestor = directory;
    while (dirname(ancestor) !== ancestor) {
      const candidate = resolve(ancestor, "node_modules", name);
      if (existsSync(resolve(candidate, "package.json"))) { collect(candidate); break; }
      ancestor = dirname(ancestor);
    }
  }
}
collect(root);
notices.push(readFileSync(resolve(destination, "LICENSE-Bun.md"), "utf8"));
writeFileSync(resolve(destination, "THIRD_PARTY_NOTICES.txt"), notices.join("\n\n----------------------------------------\n\n"));
const executable = resolve(destination, "mivlet-agent-host.exe");
const result = spawnSync(bun, ["build", "src/main.ts", "--compile", "--target=bun-windows-x64", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", `--outfile=${executable}`], {
  cwd: root, stdio: "inherit", windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
writeFileSync(resolve(destination, "runtime.json"), JSON.stringify({
  protocol: 1, sdk: "0.0.0-dev-19449", bun: "1.3.3",
  sha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
}, null, 2) + "\n");

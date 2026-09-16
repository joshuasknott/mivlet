#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectAssets, formatBytes, formatMs } from "./assets.mjs";
import { formatViolationReport, runBudgetCheck } from "./budget-check.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const desktopDist = resolve(repoRoot, "apps", "desktop", "dist");
const args = process.argv.slice(2).filter((arg) => arg !== "--");

const options = {
  build: !args.includes("--skip-build"),
  check: !args.includes("--no-check"),
  output: valueAfter("--output")
};

function valueAfter(flag) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} needs a value.`);
  }
  return value;
}

function commandLine(command, commandArgs) {
  return [command, ...commandArgs].join(" ");
}

function invocation(command, commandArgs) {
  if (process.platform !== "win32") {
    return { file: command, args: commandArgs };
  }
  return {
    file: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", command, ...commandArgs]
  };
}

function run(command, commandArgs) {
  const started = performance.now();
  return new Promise((resolveRun) => {
    const childCommand = invocation(command, commandArgs);
    const child = spawn(childCommand.file, childCommand.args, {
      cwd: repoRoot,
      shell: false,
      stdio: "inherit"
    });
    child.on("close", (code) => {
      resolveRun({
        command: commandLine(command, commandArgs),
        code,
        durationMs: performance.now() - started
      });
    });
  });
}

function markdownReport({ commandResults, assets, pnpmVersion, budgetCheck }) {
  const jsAssets = assets.filter((asset) => asset.type === "js");
  const cssAssets = assets.filter((asset) => asset.type === "css");
  const sum = (items, key) => items.reduce((total, item) => total + item[key], 0);
  const totalJs = sum(jsAssets, "bytes");
  const totalCss = sum(cssAssets, "bytes");
  const totalJsGzip = sum(jsAssets, "gzipBytes");
  const totalCssGzip = sum(cssAssets, "gzipBytes");
  const now = new Date().toISOString();
  const lines = [
    "# Mivlet Performance Baseline",
    "",
    `Generated: ${now}`,
    "",
    "## Environment",
    "",
    `- Platform: ${process.platform} ${process.arch}`,
    `- Node: ${process.version}`,
    `- pnpm: ${pnpmVersion.trim() || "unknown"}`,
    "",
    "## Timed Commands",
    "",
    "| Command | Exit | Duration |",
    "| --- | ---: | ---: |",
    ...commandResults.map(
      (result) => `| \`${result.command}\` | ${result.code} | ${formatMs(result.durationMs)} |`
    ),
    "",
    "## Desktop Bundle",
    "",
    `- JS total: ${formatBytes(totalJs)} raw, ${formatBytes(totalJsGzip)} gzip`,
    `- CSS total: ${formatBytes(totalCss)} raw, ${formatBytes(totalCssGzip)} gzip`,
    `- JS/CSS total: ${formatBytes(totalJs + totalCss)} raw, ${formatBytes(totalJsGzip + totalCssGzip)} gzip`,
    "",
    "### Largest JS/CSS Assets",
    "",
    "| Asset | Type | Raw | Gzip |",
    "| --- | --- | ---: | ---: |",
    ...assets
      .slice(0, 12)
      .map(
        (asset) =>
          `| \`${asset.path}\` | ${asset.type} | ${formatBytes(asset.bytes)} | ${formatBytes(asset.gzipBytes)} |`
      ),
    "",
    "## Budget Gate",
    "",
    budgetCheck.violations.length === 0
      ? "- Status: passed (`scripts/perf/budget.json` ceilings)"
      : "- Status: failed",
    ...(budgetCheck.violations.length === 0
      ? []
      : budgetCheck.violations.map((violation) => `- ${violation.message}`)),
    "",
    "## Limits",
    "",
    "- This reports local build timings and static Vite output sizes only.",
    "- It does not measure signed Tauri installer size, real WebView cold start, live provider latency, or production OAuth flows.",
    "- Re-run on the same machine before comparing numbers across branches."
  ];
  return `${lines.join("\n")}\n`;
}

async function readPnpmVersion() {
  const childCommand = invocation("pnpm", ["--version"]);
  const child = spawn(childCommand.file, childCommand.args, {
    cwd: repoRoot,
    shell: false,
    stdio: ["ignore", "pipe", "ignore"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  await new Promise((resolveVersion) => child.on("close", resolveVersion));
  return output;
}

const commandResults = [];
if (options.build) {
  commandResults.push(await run("pnpm", ["build"]));
}
if (commandResults.some((result) => result.code !== 0)) {
  const pnpmVersion = await readPnpmVersion();
  const report = markdownReport({
    commandResults,
    assets: [],
    pnpmVersion,
    budgetCheck: { violations: [] }
  });
  if (options.output) {
    await writeFile(resolve(repoRoot, options.output), report);
  }
  process.stdout.write(report);
  process.exitCode = 1;
  process.exit();
}

const pnpmVersion = await readPnpmVersion();
const assets = await collectAssets(desktopDist, repoRoot);
const budgetCheck = options.check ? await runBudgetCheck() : { violations: [] };
const report = markdownReport({ commandResults, assets, pnpmVersion, budgetCheck });

if (options.output) {
  await writeFile(resolve(repoRoot, options.output), report);
}

process.stdout.write(report);

if (budgetCheck.violations.length > 0) {
  process.stderr.write(formatViolationReport(budgetCheck.violations, budgetCheck.budget));
  process.exitCode = 1;
}

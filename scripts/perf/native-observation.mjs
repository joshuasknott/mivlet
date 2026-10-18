import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, parseEnv } from "node:util";

const identity = (process) => `${process.pid}:${process.createdAt}`;

/** Keep process identity, not just PID: Windows can reuse a dead child's PID. */
export function selectProcessTree(processes, root, known = new Set()) {
  const selected = new Map();
  for (const process of processes) {
    if (identity(process) === identity(root) || known.has(identity(process))) {
      selected.set(process.pid, process);
    }
  }
  let changed;
  do {
    changed = false;
    for (const process of processes) {
      const parent = selected.get(process.parentPid);
      if (!selected.has(process.pid) && parent && process.createdAt >= parent.createdAt) {
        selected.set(process.pid, process);
        changed = true;
      }
    }
  } while (changed);
  for (const process of selected.values()) known.add(identity(process));
  return [...selected.values()];
}

export function summarizeSamples(samples) {
  if (!samples.length) throw new Error("No native process samples were collected.");
  const totals = samples.map((sample) => ({
    elapsedMs: sample.elapsedMs,
    workingSetBytes: sample.processes.reduce((sum, process) => sum + process.workingSetBytes, 0),
    privateBytes: sample.processes.reduce((sum, process) => sum + process.privateBytes, 0),
  }));
  // A peak of simultaneous totals, never a sum of peaks from different times.
  const settled = totals.filter((sample) => sample.elapsedMs >= totals.at(-1).elapsedMs / 2);
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  return {
    sampleCount: samples.length,
    observedThroughMs: totals.at(-1).elapsedMs,
    peakWorkingSetBytes: Math.max(...totals.map((sample) => sample.workingSetBytes)),
    peakPrivateBytes: Math.max(...totals.map((sample) => sample.privateBytes)),
    settledMedianWorkingSetBytes: median(settled.map((sample) => sample.workingSetBytes)),
    settledMedianPrivateBytes: median(settled.map((sample) => sample.privateBytes)),
  };
}

async function observe() {
  if (process.platform !== "win32") throw new Error("Native observation requires Windows.");
  const { values } = parseArgs({ options: {
    exe: { type: "string" }, output: { type: "string" },
    duration: { type: "string", default: "60" }, "env-file": { type: "string" },
  } });
  if (!values.exe || !values.output) throw new Error("Pass --exe and --output.");
  const duration = Number(values.duration);
  if (!Number.isInteger(duration) || duration < 5 || duration > 300) {
    throw new Error("Duration must be an integer from 5 to 300 seconds.");
  }
  const executable = resolve(values.exe);
  const output = resolve(values.output);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(executable)) hash.update(chunk);
  const sha256 = hash.digest("hex");
  await mkdir(dirname(output), { recursive: true });
  const environment = { ...process.env };
  if (values["env-file"]) Object.assign(environment, parseEnv(await readFile(values["env-file"], "utf8")));
  const launch = { executable, sha256, workingDirectory: process.cwd() };
  const sampler = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File",
    fileURLToPath(new URL("./native-samples.ps1", import.meta.url)),
    "-Executable", executable, "-DurationSeconds", String(duration),
    "-WorkingDirectory", launch.workingDirectory,
  ], { env: environment, windowsHide: true, stdio: ["ignore", "pipe", "inherit"] });
  const completion = new Promise((accept) => {
    sampler.once("error", (error) => accept({ error: error.message }));
    sampler.once("exit", (code) => accept({ code }));
  });
  const samples = [];
  const known = new Set();
  let root;
  let firstResponsiveWindowMs = null;
  let exitedEarly = false;
  let failure = null;
  const watchdog = setTimeout(() => {
    failure = "Native sampler exceeded its bounded observation deadline.";
    sampler.kill();
  }, (duration + 30) * 1000);
  try {
    for await (const line of createInterface({ input: sampler.stdout })) {
      if (!line.trim()) continue;
      const sample = JSON.parse(line);
      if (sample.event === "launched") {
        Object.assign(launch, { pid: sample.pid, launchedAt: sample.launchedAt });
        await writeFile(`${output}.launch.json`, JSON.stringify(launch, null, 2));
        console.log(JSON.stringify({ event: "launched", ...launch }));
      }
      if (sample.event === "window") firstResponsiveWindowMs = sample.elapsedMs;
      if (sample.event === "exit") exitedEarly = true;
      if (sample.event !== "sample") continue;
      // The sampler holds the original process handle and checks it before and
      // after each inventory. This first PID lookup cannot bind a reused PID.
      root ??= sample.processes.find((candidate) => candidate.pid === launch.pid);
      if (!root) continue;
      samples.push({ elapsedMs: sample.elapsedMs,
        processes: selectProcessTree(sample.processes, root, known) });
    }
  } catch (error) {
    failure = error.message;
    sampler.kill();
  }
  const result = await completion;
  clearTimeout(watchdog);
  failure ??= result.error ?? (result.code !== 0 ? `Native sampler exited ${result.code}.` : null);
  if (!samples.length) failure ??= "No native process samples were collected.";
  const summary = samples.length ? summarizeSamples(samples) : null;
  const report = { ...launch, rootIdentity: root ? { pid: root.pid, createdAt: root.createdAt } : null,
    requestedDurationSeconds: duration, firstResponsiveWindowMs, exitedEarly, failure,
    summary, samples,
    limits: ["Window readiness means a titled, responsive native window, not renderer/workspace readiness.",
      "Working sets include shared pages; their sum can double-count physical RAM. Private bytes measure committed private memory.",
      "Only the launched process and observed descendants are included. Brief processes between samples can be missed.",
      "The app is left open, including after observation failures; close it normally before a repeated run."] };
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ event: "complete", output, firstResponsiveWindowMs, exitedEarly, failure, summary }));
  if (failure || exitedEarly || firstResponsiveWindowMs === null) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await observe();
}

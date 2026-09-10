import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
export const executable = resolve(testDirectory, "../../../../apps/desktop/src-tauri/resources/agent-host/mivlet-agent-host.exe");

function timeoutError(label, events) {
  const recent = events.slice(-8).map(event => JSON.stringify(event)).join("\n");
  return new Error(`Timed out waiting for ${label}. Recent host output:\n${recent}`);
}

export class AgentHostProcess {
  #events = [];
  #history = [];
  #frames = [];
  #waiters = [];
  #closed;

  constructor(args = []) {
    this.directory = mkdtempSync(join(tmpdir(), "mivlet-agent-host-test-"));
    this.child = spawn(executable, args, {
      cwd: this.directory,
      env: { ...Object.fromEntries(["SystemRoot", "WINDIR"].filter(key => process.env[key]).map(key => [key, process.env[key]])), TEMP: this.directory, TMP: this.directory },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    this.#closed = new Promise((resolve) => {
      this.child.once("close", (code, signal) => resolve({ code, signal }));
    });
    this.child.stdout.setEncoding("utf8");
    let buffer = "";
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch (error) {
          event = { type: "invalid-json", line, error: String(error) };
        }
        this.#events.push(event);
        this.#history.push(event);
        this.#resolveWaiters();
      }
    });
  }

  get events() {
    return [...this.#history];
  }

  get frames() {
    return [...this.#frames];
  }

  write(frame) {
    this.#frames.push(frame);
    if (!this.child.stdin.writable) return false;
    return this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  next(predicate, label = "host event", timeoutMs = 12_000) {
    const index = this.#events.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.#events.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      const timer = setTimeout(() => {
        const position = this.#waiters.indexOf(waiter);
        if (position >= 0) this.#waiters.splice(position, 1);
        reject(timeoutError(label, this.#events));
      }, timeoutMs);
      waiter.timer = timer;
      this.#waiters.push(waiter);
      this.#resolveWaiters();
    });
  }

  nextType(type, timeoutMs = 12_000) {
    return this.next((event) => event.type === type, `${type} event`, timeoutMs);
  }

  async close() {
    if (!this.child.killed && this.child.exitCode === null) this.child.kill();
    return this.#closed;
  }

  async dispose() {
    await this.close();
    rmSync(this.directory, { recursive: true, force: true });
  }

  async waitForExit() {
    return this.#closed;
  }

  files() {
    const result = [];
    const visit = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else result.push(path);
      }
    };
    visit(this.directory);
    return result;
  }

  containsBytes(needle) {
    const target = Buffer.from(needle, "utf8");
    return this.files().some((path) => readFileSync(path).includes(target));
  }

  #resolveWaiters() {
    for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#waiters[index];
      const eventIndex = this.#events.findIndex(waiter.predicate);
      if (eventIndex < 0) continue;
      clearTimeout(waiter.timer);
      this.#waiters.splice(index, 1);
      waiter.resolve(this.#events.splice(eventIndex, 1)[0]);
    }
  }
}

export function fixtureInput(overrides = {}) {
  const parameters = JSON.stringify({
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  });
  return {
    providerId: "openai",
    request: {
      model: "fixture-model",
      messages: [{ role: "user", content: overrides.prompt ?? "fixture prompt" }],
      tools: [{ name: "write_summary", description: "Write a short fixture summary.", parameters }],
      maxTokens: 256,
    },
    maxTurns: 3,
    maxToolCalls: 3,
    ...overrides,
  };
}

export function chunk(delta, finishReason = null) {
  return JSON.stringify({
    id: "fixture-completion",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

export function usageChunk(inputTokens, outputTokens) {
  return JSON.stringify({
    id: "fixture-completion",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture-model",
    choices: [],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  });
}

export function sendChunks(host, id, lines) {
  lines.forEach((line, sequence) => host.write({ type: "model-chunk", id, sequence, line }));
}

export async function withHost(callback) {
  const host = new AgentHostProcess();
  try {
    return await callback(host);
  } finally {
    await host.dispose();
  }
}

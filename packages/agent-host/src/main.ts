import { resolve } from "node:path";
import type { HostInput } from "./host";

// Rust supplies a fresh private working directory and a cleared environment.
// These assignments precede SDK module evaluation, including global services.
const directory = process.cwd();
for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) process.env[key] = resolve(directory, "sdk");
if (process.argv.includes("--mcp")) {
  const { runMcpHost } = await import("./mcp");
  await runMcpHost();
  process.exit(0);
}
const { runHost } = await import("./host");
const abort = new AbortController();
let started = false;
let terminal = false;
let nextModel = 0;
const models = new Map<number, { controller: ReadableStreamDefaultController<Uint8Array>; sequence: number }>();
const tools = new Map<string, (result: { ok: boolean; output: string }) => void>();
const encoder = new TextEncoder();
function emit(event: unknown) { if (!terminal) process.stdout.write(JSON.stringify(event) + "\n"); }
function stop() {
  abort.abort();
  for (const { controller } of models.values()) controller.error(new Error("Cancelled"));
  models.clear();
  for (const reply of tools.values()) reply({ ok: false, output: "Cancelled" });
  tools.clear();
}
async function start(input: HostInput) {
  try {
    if (!["openai", "anthropic", "xai", "deepseek", "openrouter", "custom"].includes(input.providerId)
      || !input.request || input.request.messages.some(message => message.images?.length)
      || !Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 32
      || !Number.isInteger(input.maxToolCalls) || input.maxToolCalls < 1 || input.maxToolCalls > 80
      || input.request.tools.length > 100) throw new Error("Unsupported host request");
    if (input.contextWindow !== undefined && (!Number.isInteger(input.contextWindow) || input.contextWindow < 1024 || input.contextWindow > 2_000_000)) throw new Error("Unsupported context budget");
    await runHost(input, {
      directory, signal: abort.signal,
      event: emit,
      async model(body) {
        abort.signal.throwIfAborted();
        if (models.size) throw new Error("Concurrent model requests are unavailable.");
        const id = ++nextModel;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) { models.set(id, { controller, sequence: 0 }); },
          cancel() { models.delete(id); },
        });
        emit({ type: "model-request", id, body });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
      async tool(callId, tool, args) {
        abort.signal.throwIfAborted();
        const result = new Promise<{ ok: boolean; output: string }>(resolve => tools.set(callId, resolve));
        emit({ type: "tool-request", callId, tool, arguments: args });
        return result;
      },
    });
  } catch {
    emit(abort.signal.aborted ? { type: "cancelled" } : { type: "error", message: "The embedded agent could not complete this turn.", code: "transport", retryable: false });
  } finally {
    terminal = true; stop();
    process.exit(0);
  }
}
function frame(raw: string) {
  const value = JSON.parse(raw);
  if (value.type === "start" && !started) { started = true; void start(value.input); return; }
  if (value.type === "cancel") { stop(); return; }
  if (abort.signal.aborted) return;
  if (value.type === "tool-result") {
    const reply = tools.get(value.callId);
    if (!reply || typeof value.ok !== "boolean" || typeof value.output !== "string" || value.output.length > 64_000) throw new Error("Invalid tool reply");
    tools.delete(value.callId); reply({ ok: value.ok, output: value.output }); return;
  }
  if (value.type === "model-chunk") {
    const pending = models.get(value.id);
    if (!pending || value.sequence !== pending.sequence++ || typeof value.line !== "string") throw new Error("Invalid provider reply");
    if (value.line === "[CANCELLED]") { stop(); return; }
    if (value.line === "[DONE]") { pending.controller.close(); models.delete(value.id); return; }
    const data = JSON.parse(value.line);
    if (data.__fableTransport) {
      if (data.__fableTransport.kind === "retrying") {
        emit({ type: "retrying" });
      } else if (data.__fableTransport.kind === "error") {
        emit({ type: "error", message: data.__fableTransport.message, code: data.__fableTransport.code, retryable: data.__fableTransport.retryable });
        pending.controller.error(new Error("Provider failed")); models.delete(value.id);
      }
      return;
    }
    if (data.__fableComputerTool) throw new Error("Computer pixels require the native visual route.");
    pending.controller.enqueue(encoder.encode(`${typeof data.type === "string" ? `event: ${data.type}\n` : ""}data: ${value.line}\n\n`));
    return;
  }
  throw new Error("Invalid host frame");
}
let buffer = "";
const decoder = new TextDecoder("utf-8", { fatal: true });
try {
  for await (const chunk of process.stdin) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 3 * 1024 * 1024) throw new Error("Host frame too large");
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      frame(line);
    }
  }
} catch { emit({ type: "error", message: "The embedded agent transport was interrupted.", code: "transport", retryable: false }); }
stop();

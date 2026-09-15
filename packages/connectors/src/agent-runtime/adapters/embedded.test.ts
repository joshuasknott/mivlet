import { describe, expect, it, vi } from "vitest";
import type { AgentTurnRequest, BackendAgentEvent, BackendProvider } from "@mivlet/protocol";
import type { BackendDeps, EmbeddedRuntimeEvent, EmbeddedRuntimeHandle } from "../contract";
import { registeredToolSpecs } from "../../native-api/tools";
import { createEmbeddedBackend } from "./embedded";

const provider: BackendProvider = {
  id: "openai",
  backendType: "native-api",
  driverKind: "native-api",
  label: "OpenAI",
  description: "OpenAI native SDK",
  authState: "connected",
  capabilities: ["authentication", "streaming", "tool-requests", "approvals", "cancellation"],
  models: [{
    id: "fixture-model",
    label: "Fixture model",
    available: true,
    capabilities: { streaming: true, tools: true },
  }],
};

const request: AgentTurnRequest = {
  model: "fixture-model",
  messages: [{ role: "user", content: "Read the fixture file." }],
  tools: registeredToolSpecs().filter((tool) => ["read-file", "run-shell"].includes(tool.name)),
  maxTokens: 256,
};

function runtimeFor(events: EmbeddedRuntimeEvent[]) {
  const replies: Array<{ callId: string; ok: boolean; output: string }> = [];
  const cancelled = vi.fn(async () => undefined);
  const reply = vi.fn(async (callId: string, ok: boolean, output: string) => {
    replies.push({ callId, ok, output });
  });
  const runtime: EmbeddedRuntimeHandle = {
    async *run() {
      for (const event of events) yield event;
    },
    reply,
    cancel: cancelled,
  };
  const deps: BackendDeps = {
    createTransport: () => null,
    createEmbeddedRuntime: () => runtime,
  };
  return { runtime, reply, deps, replies, cancelled };
}

async function collect(stream: AsyncIterable<BackendAgentEvent> | null) {
  const events: BackendAgentEvent[] = [];
  if (!stream) return events;
  for await (const event of stream) events.push(event);
  return events;
}

describe("embedded SDK agent backend", () => {
  it("remembers cancellation before iteration without relying on the caller's polling hook", async () => {
    const fixture = runtimeFor([{ type: "tool-request", callId: "never", tool: "read-file", arguments: "{}" }]);
    const backend = createEmbeddedBackend(provider, fixture.deps);
    const execute = vi.fn(async () => "should not run");
    const stream = backend.run(request, { execute, attemptId: "early-stop" });
    await backend.cancel("early-stop");
    expect(await collect(stream)).toEqual([{ type: "cancelled" }]);
    expect(execute).not.toHaveBeenCalled();
    expect(fixture.reply).not.toHaveBeenCalled();
  });
  it("routes an injected SDK tool request through the existing approval and execute path", async () => {
    const fixture = runtimeFor([
      { type: "text-delta", text: "I will read it." },
      { type: "tool-request", callId: "read-call", tool: "read-file", arguments: '{"path":"notes.txt"}' },
      { type: "done", finishReason: "stop" },
    ]);
    const execute = vi.fn(async (..._args: [unknown, string]) => "fixture contents");
    const backend = createEmbeddedBackend(provider, fixture.deps);

    const events = await collect(backend.run(request, {
      execute,
      attemptId: "attempt-1",
      permissionMode: "read-only",
    }));

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      id: "native-attempt-1-read-call",
      service: "openai",
      action: expect.stringContaining("read-file"),
      mode: "read-only",
    });
    expect(execute.mock.calls[0]?.[1]).toBe('{"path":"notes.txt"}');
    expect(fixture.reply).toHaveBeenCalledOnce();
    expect(fixture.reply).toHaveBeenCalledWith("read-call", true, "fixture contents");
    expect(events).toContainEqual({ type: "tool-result", callId: "read-call", ok: true, output: "fixture contents" });
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop" });
    expect(fixture.cancelled).toHaveBeenCalled();
  });

  it("forwards embedded transport retries to the persisted-run callback", async () => {
    const fixture = runtimeFor([
      { type: "retrying" },
      { type: "retrying" },
      { type: "done", finishReason: "stop" },
    ]);
    const onRetry = vi.fn();
    const backend = createEmbeddedBackend(provider, fixture.deps);

    expect(await collect(backend.run(request, {
      execute: async () => "",
      onRetry,
    }))).toEqual([{ type: "done", finishReason: "stop" }]);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it.each([0, 1, 16, 35, 36, 64])("keeps tool output within a %i-character limit", async (limit) => {
    const fixture = runtimeFor([
      { type: "tool-request", callId: `bounded-${limit}`, tool: "read-file", arguments: '{"path":"large.txt"}' },
      { type: "done", finishReason: "stop" },
    ]);
    const backend = createEmbeddedBackend(provider, fixture.deps);
    const events = await collect(backend.run(request, {
      execute: async () => "x".repeat(256),
      maxToolOutputCharacters: limit,
    }));
    const result = events.find((event) => event.type === "tool-result");

    expect(result?.output.length).toBeLessThanOrEqual(limit);
    expect(fixture.reply.mock.calls[0]?.[2].length).toBeLessThanOrEqual(limit);
  });

  it.each([
    {
      name: "a tool that was not advertised",
      events: [{ type: "tool-request", callId: "mismatch-call", tool: "write-file", arguments: "{}" }],
    },
    {
      name: "a replayed call id",
      events: [
        { type: "tool-request", callId: "same-call", tool: "read-file", arguments: '{"path":"one.txt"}' },
        { type: "tool-request", callId: "same-call", tool: "read-file", arguments: '{"path":"two.txt"}' },
      ],
    },
  ])("fails closed for $name", async ({ events: sourceEvents }) => {
    const fixture = runtimeFor(sourceEvents as EmbeddedRuntimeEvent[]);
    const execute = vi.fn(async (..._args: [unknown, string]) => "approved result");
    const backend = createEmbeddedBackend(provider, fixture.deps);
    const events = await collect(backend.run(request, {
      execute,
      attemptId: "attempt-safe",
      permissionMode: "read-only",
    }));

    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "error" });
    if (sourceEvents[0]?.tool === "write-file") {
      expect(execute).not.toHaveBeenCalled();
      expect(fixture.reply).not.toHaveBeenCalled();
    } else {
      expect(execute).toHaveBeenCalledOnce();
      expect(fixture.reply).toHaveBeenCalledOnce();
    }
  });

  it("denies a disallowed tool before execution and returns the denial to the SDK", async () => {
    const fixture = runtimeFor([
      { type: "tool-request", callId: "shell-call", tool: "run-shell", arguments: '{"command":"whoami","location":"hosted"}' },
      { type: "done", finishReason: "stop" },
    ]);
    const execute = vi.fn(async (..._args: [unknown, string]) => "must not run");
    const backend = createEmbeddedBackend(provider, fixture.deps);
    const events = await collect(backend.run(request, {
      execute,
      permissionMode: "read-only",
    }));

    expect(execute).not.toHaveBeenCalled();
    expect(fixture.reply).toHaveBeenCalledOnce();
    expect(fixture.reply.mock.calls[0]?.[0]).toBe("shell-call");
    expect(fixture.reply.mock.calls[0]?.[1]).toBe(false);
    expect(fixture.reply.mock.calls[0]?.[2]).toMatch(/permission denied/i);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool-result", callId: "shell-call", ok: false }));
  });

  it("does not send a late tool reply when Stop races a delayed execute", async () => {
    let resolveExecute!: (value: string) => void;
    let cancelled = false;
    const fixture = runtimeFor([
      { type: "tool-request", callId: "delayed-call", tool: "read-file", arguments: '{"path":"late.txt"}' },
    ]);
    const execute = vi.fn((_approval: unknown, _args: string) => new Promise<string>((resolve) => { resolveExecute = resolve; }));
    const backend = createEmbeddedBackend(provider, fixture.deps);
    const iterator = backend.run(request, {
      execute,
      attemptId: "attempt-stop",
      permissionMode: "read-only",
      shouldCancel: () => cancelled,
    })![Symbol.asyncIterator]();

    expect((await iterator.next()).value).toMatchObject({ type: "tool-call", callId: "delayed-call" });
    const delayed = iterator.next();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    cancelled = true;
    await backend.cancel("attempt-stop");
    resolveExecute("late contents");

    expect(await delayed).toEqual({ value: { type: "cancelled" }, done: false });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(fixture.reply).not.toHaveBeenCalled();
    expect(fixture.cancelled).toHaveBeenCalled();
  });
});

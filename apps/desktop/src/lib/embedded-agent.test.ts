import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendProvider } from "@mivlet/protocol";
import type { EmbeddedRuntimeEvent } from "@mivlet/connectors";

const mocks = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
  reply: vi.fn(async () => undefined),
  listen: vi.fn(),
  unlisten: vi.fn(),
  receive: undefined as ((event: EmbeddedRuntimeEvent) => void) | undefined,
}));

vi.mock("@mivlet/connectors", () => ({
  resolveModelCapabilities: vi.fn(() => ({ contextWindow: 16_384 })),
}));
vi.mock("../runtime/domains/embedded-agent", () => ({
startRuntimeEmbeddedAgent: mocks.start,
cancelRuntimeEmbeddedAgent: mocks.cancel,
replyRuntimeEmbeddedAgent: mocks.reply,
listenRuntimeEmbeddedAgent: mocks.listen
}));

import { createDesktopEmbeddedRuntime } from "./embedded-agent";

const provider: BackendProvider = {
  id: "openai",
  backendType: "native-api",
  driverKind: "native-api",
  label: "OpenAI",
  description: "OpenAI native SDK",
  authState: "connected",
  capabilities: ["authentication", "streaming", "tool-requests", "approvals", "cancellation"],
  models: [{ id: "fixture-model", label: "Fixture model", available: true, capabilities: { contextWindow: 16_384 } }],
};

const request = {
  model: "fixture-model",
  messages: [{ role: "user" as const, content: "hello" }],
  tools: [],
  maxTokens: 128,
};

const options = {
  contextPrefix: "fixture context",
  maxTurns: 3,
  maxToolCalls: 3,
};

function nativeWindow() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

afterEach(() => {
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  mocks.start.mockReset();
  mocks.start.mockResolvedValue(undefined);
  mocks.cancel.mockReset();
  mocks.cancel.mockResolvedValue(undefined);
  mocks.reply.mockReset();
  mocks.reply.mockResolvedValue(undefined);
  mocks.listen.mockReset();
  mocks.unlisten.mockReset();
  mocks.receive = undefined;
});

describe("desktop embedded agent renderer boundary", () => {
  it("returns an explicit unavailable runtime in browser preview", () => {
    expect(createDesktopEmbeddedRuntime(provider)).toBeNull();
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("keeps listener events queued while native start is still pending", async () => {
    nativeWindow();
    const start = deferred<undefined>();
    mocks.start.mockReturnValueOnce(start.promise);
    mocks.listen.mockImplementationOnce(async (_requestId: string, receive: (event: EmbeddedRuntimeEvent) => void) => {
      mocks.receive = receive;
      return mocks.unlisten;
    });
    const runtime = createDesktopEmbeddedRuntime(provider);
    expect(runtime).not.toBeNull();
    const iterator = runtime!.run(request, options)[Symbol.asyncIterator]();
    const first = iterator.next();
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    expect(mocks.receive).toBeDefined();

    mocks.receive!({ type: "text-delta", text: "queued before start resolves" });
    mocks.receive!({ type: "done", finishReason: "stop" });
    start.resolve(undefined);

    expect(await first).toEqual({ value: { type: "text-delta", text: "queued before start resolves" }, done: false });
    expect(await iterator.next()).toEqual({ value: { type: "done", finishReason: "stop" }, done: false });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({
      requestId: expect.any(String),
      providerId: "openai",
      request,
      contextPrefix: "fixture context",
      maxTurns: 3,
      maxToolCalls: 3,
      contextWindow: 16_384,
    }));
    expect(mocks.unlisten).toHaveBeenCalledOnce();
    expect(mocks.cancel).toHaveBeenCalledWith(expect.any(String));
  });

  it("cancels before listener registration resolves without starting the native run or accepting late events", async () => {
    nativeWindow();
    const listener = deferred<() => void>();
    mocks.listen.mockImplementationOnce(async (_requestId: string, receive: (event: EmbeddedRuntimeEvent) => void) => {
      mocks.receive = receive;
      await listener.promise;
      return mocks.unlisten;
    });
    const runtime = createDesktopEmbeddedRuntime(provider);
    expect(runtime).not.toBeNull();
    const iterator = runtime!.run(request, options)[Symbol.asyncIterator]();
    const first = iterator.next();
    await runtime!.cancel();
    listener.resolve(mocks.unlisten);

    expect(await first).toEqual({ value: { type: "cancelled" }, done: false });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.unlisten).toHaveBeenCalledOnce();
    expect(mocks.cancel).toHaveBeenCalledWith(expect.any(String));
    await expect(runtime!.reply("late-call", true, "late result")).rejects.toThrow("agent was stopped");
    mocks.receive?.({ type: "text-delta", text: "late event" });
    expect(mocks.reply).not.toHaveBeenCalled();
  });
});

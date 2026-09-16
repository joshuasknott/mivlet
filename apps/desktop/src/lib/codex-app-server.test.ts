import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTurnRequest, BackendProvider } from "@mivlet/protocol";
import type { RuntimeCodexEvent } from "../runtime/domains/providers";
import { createDesktopCodexAppServer } from "./codex-app-server";

const runtimeMocks = vi.hoisted(() => {
  let listener: ((event: RuntimeCodexEvent) => void) | null = null;
  return {
    getRuntimeCodexStatus: vi.fn(async () => ({
      installed: true,
      authenticated: true,
      authMethod: "chatgpt"
    })),
    startRuntimeCodexTurn: vi.fn(async () => null),
    listenRuntimeCodexEvents: vi.fn(async (
      _requestId: string,
      onEvent: (event: RuntimeCodexEvent) => void
    ) => {
      listener = onEvent;
      return () => {
        listener = null;
      };
    }),
    respondRuntimeCodexApproval: vi.fn(async () => null),
    interruptRuntimeCodexTurn: vi.fn(async () => null),
    shutdownRuntimeCodexTurn: vi.fn(async () => null),
    emit(event: RuntimeCodexEvent) {
      listener?.(event);
    },
    reset() {
      listener = null;
    }
  };
});

vi.mock("../runtime/domains/providers", () => runtimeMocks);

const provider: BackendProvider = {
  id: "codex",
  backendType: "codex-app-server",
  label: "Codex",
  description: "Codex app-server",
  authState: "connected",
  capabilities: ["authentication", "threads", "streaming", "cancellation"],
  models: [{ id: "gpt-5", label: "GPT-5", available: true }]
};

const request: AgentTurnRequest = {
  model: "gpt-5",
  messages: [{ role: "user", content: "Say hello." }],
  tools: [],
  maxTokens: 64
};

describe("desktop Codex app-server client", () => {
  beforeEach(() => {
    runtimeMocks.reset();
    vi.clearAllMocks();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true
    });
  });

  it("does not launch version and login probes before each message", async () => {
    const client = createDesktopCodexAppServer(provider, { onRequestStarted: vi.fn(), onRetry: vi.fn() })!;
    await client.initialize();
    expect(runtimeMocks.getRuntimeCodexStatus).not.toHaveBeenCalled();
  });

  it("keeps streaming after the native start command acknowledges process startup", async () => {
    const handle = createDesktopCodexAppServer(provider, {
      onRequestStarted: vi.fn(),
      onRetry: vi.fn()
    });
    expect(handle).not.toBeNull();
    await handle!.initialize();
    const thread = await handle!.startThread(request);
    const events = handle!.submitTurn({
      threadId: thread.threadId,
      request,
      options: { attemptId: "attempt-1", permissionMode: "read-only" }
    })[Symbol.asyncIterator]();

    const delta = events.next();
    await vi.waitFor(() => expect(runtimeMocks.startRuntimeCodexTurn).toHaveBeenCalledOnce());
    runtimeMocks.emit({ type: "text-delta", text: "Hello" });
    await expect(delta).resolves.toEqual({
      done: false,
      value: { type: "text-delta", text: "Hello" }
    });

    const terminal = events.next();
    runtimeMocks.emit({ type: "done", finishReason: "stop" });
    await expect(terminal).resolves.toEqual({
      done: false,
      value: { type: "done", finishReason: "stop" }
    });
    await expect(events.next()).resolves.toEqual({ done: true, value: undefined });
  });
});

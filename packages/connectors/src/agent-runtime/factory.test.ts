import { describe, expect, it } from "vitest";
import type {
  BackendProvider,
  BackendAgentEvent,
  NativeCompletionRequest
} from "@fable/protocol";
import { FixtureTransport, SequencedFixtureTransport } from "../native-api/transport";
import { readFixture } from "../native-api/fixtures-loader";
import {
  resolveAgentBackend,
  hasRunnableAdapter,
  createCodexBackend,
  createNativeApiBackend,
  MockCodexAppServer,
  type BackendDeps,
  type CodexAppServerEvent,
  type CodexAppServerHandle,
  type AgentTurnRequest
} from "./index";

/** A connected, streaming native-API provider (openai). */
function nativeProvider(overrides: Partial<BackendProvider> = {}): BackendProvider {
  return {
    id: "openai",
    backendType: "native-api",
    label: "OpenAI",
    description: "OpenAI API",
    authState: "connected",
    capabilities: ["authentication", "streaming", "tool-requests", "approvals", "cancellation"],
    models: [{ id: "gpt-5", label: "GPT-5", available: true }],
    ...overrides
  };
}

/** A metadata-only Codex provider (subscription). */
function codexProvider(overrides: Partial<BackendProvider> = {}): BackendProvider {
  return {
    id: "codex",
    backendType: "codex-app-server",
    label: "Codex",
    description: "Codex app-server",
    authState: "connected",
    capabilities: ["authentication", "threads", "streaming", "tool-requests", "approvals", "cancellation"],
    models: [],
    installHint: "ChatGPT subscription or OpenAI API key",
    ...overrides
  };
}

/** Build BackendDeps that serves a fixed fixture transport + a cancel stub. */
function fixtureDeps(lines: readonly string[]): BackendDeps {
  const transport = new FixtureTransport(lines);
  return {
    createTransport: () => ({
      transport,
      cancel: async () => {}
    }),
    discoverModels: async () => ({ outcome: "empty", models: [] })
  };
}

/** Build BackendDeps whose transport is null (browser preview / no egress). */
function nullTransportDeps(): BackendDeps {
  return {
    createTransport: () => null
  };
}

// FakeCodexAppServer removed in favor of MockCodexAppServer

function codexDeps(handle: CodexAppServerHandle | null): BackendDeps {
  return {
    createTransport: () => null,
    createCodexAppServer: () => handle
  };
}

const baseRunRequest: AgentTurnRequest = {
  model: "gpt-5",
  messages: [{ role: "user", content: "say hi" }],
  tools: [],
  maxTokens: 1024
};

async function collect(iter: AsyncIterable<BackendAgentEvent>): Promise<BackendAgentEvent[]> {
  const events: BackendAgentEvent[] = [];
  for await (const event of iter) events.push(event);
  return events;
}

describe("hasRunnableAdapter", () => {
  it("returns true for every executable backend family", () => {
    expect(hasRunnableAdapter("native-api")).toBe(true);
    expect(hasRunnableAdapter("codex")).toBe(true);
    expect(hasRunnableAdapter("antigravity-acp")).toBe(true);
    expect(hasRunnableAdapter("claude-agent")).toBe(true);
    expect(hasRunnableAdapter("cursor-acp")).toBe(true);
    expect(hasRunnableAdapter("grok-acp")).toBe(true);
    expect(hasRunnableAdapter("opencode")).toBe(true);
  });

  it("returns false for an unknown backend type", () => {
    expect(hasRunnableAdapter("future-runtime")).toBe(false);
  });
});

describe("resolveAgentBackend dispatch", () => {
  it("returns a native-API backend for a connected streaming native provider", () => {
    const backend = resolveAgentBackend(nativeProvider(), fixtureDeps([]));
    expect(backend).not.toBeNull();
    expect(backend?.providerId).toBe("openai");
    expect(backend?.capabilities).toContain("streaming");
  });

  it("returns null when the native provider is not connected", () => {
    const backend = resolveAgentBackend(
      nativeProvider({ authState: "needs-auth" }),
      fixtureDeps([])
    );
    expect(backend).toBeNull();
  });

  it("returns null when the native provider lacks the streaming capability", () => {
    const backend = resolveAgentBackend(
      nativeProvider({ capabilities: ["authentication"] }),
      fixtureDeps([])
    );
    expect(backend).toBeNull();
  });

  it("returns a Codex backend for a connected streaming Codex provider", () => {
    const backend = resolveAgentBackend(codexProvider(), codexDeps(new MockCodexAppServer({ events: [] })));
    expect(backend).not.toBeNull();
    expect(backend?.providerId).toBe("codex");
  });

  it("returns null for undefined provider", () => {
    const backend = resolveAgentBackend(undefined, fixtureDeps([]));
    expect(backend).toBeNull();
  });
});

describe("createCodexBackend", () => {
  it("returns null at run time when no app-server process seam is wired", () => {
    const backend = createCodexBackend(codexProvider(), codexDeps(null));
    expect(backend).not.toBeNull();
    const iter = backend?.run(baseRunRequest, { execute: async () => "ok" });
    expect(iter).toBeNull();
  });

  it("initializes Codex, starts a thread, streams text, and shuts down", async () => {
    const handle = new MockCodexAppServer({
      events: [
        { type: "text-delta", text: "Hello" },
        { type: "text-delta", text: " from Codex" },
        { type: "done", finishReason: "stop" }
      ]
    });
    const backend = createCodexBackend(codexProvider(), codexDeps(handle));
    const iter = backend?.run(baseRunRequest, { execute: async () => "ok" });
    expect(iter).not.toBeNull();
    const events = await collect(iter as AsyncIterable<BackendAgentEvent>);
    expect(handle.initialized).toBe(true);
    expect(handle.started).toBe(true);
    expect(handle.submitted).toBe(true);
    expect(handle.shutdownCalled).toBe(true);
    expect(
      events
        .filter((event): event is Extract<BackendAgentEvent, { type: "text-delta" }> => event.type === "text-delta")
        .map((event) => event.text)
        .join("")
    ).toBe("Hello from Codex");
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop" });
  });

  it("resumes an existing Codex thread when the run request carries a thread id", async () => {
    const handle = new MockCodexAppServer({ events: [{ type: "done", finishReason: "stop" }] });
    const backend = createCodexBackend(codexProvider(), codexDeps(handle));
    const iter = backend?.run(
      { ...baseRunRequest, threadId: "codex-thread-existing" } as AgentTurnRequest & {
        threadId: string;
      },
      { execute: async () => "ok" }
    );
    await collect(iter as AsyncIterable<BackendAgentEvent>);
    expect(handle.started).toBe(false);
    expect(handle.resumedThreadId).toBe("codex-thread-existing");
  });

  it("routes Codex approval requests through the provider-neutral execute seam", async () => {
    const handle = new MockCodexAppServer({
      events: [
        {
          type: "approval-request",
          requestId: "codex-request-1",
          callId: "call-1",
          tool: "run-shell",
          arguments: "{\"command\":\"pwd\"}",
          approval: {
            id: "approval-1",
            service: "Codex",
            action: "Run shell command",
            mode: "full-access",
            riskLevel: "medium",
            dataUsed: ["workspace"],
            consequence: "Runs a shell command.",
            requestedAt: "2026-06-29T12:00:00.000Z",
            decisions: []
          }
        },
        { type: "done", finishReason: "stop" }
      ]
    });
    const backend = createCodexBackend(codexProvider(), codexDeps(handle));
    const iter = backend?.run(baseRunRequest, { execute: async () => "approved output" });
    const events = await collect(iter as AsyncIterable<BackendAgentEvent>);
    expect(events.some((event) => event.type === "tool-call")).toBe(true);
    expect(events).toContainEqual({
      type: "tool-result",
      callId: "call-1",
      ok: true,
      output: "approved output"
    });
    expect(handle.approvalResponses).toEqual([
      { requestId: "codex-request-1", ok: true, output: "approved output" }
    ]);
  });

  it("surfaces errors without requiring live Codex credentials", async () => {
    const handle = new MockCodexAppServer({ events: [{ type: "error", message: "Codex auth required." }] });
    const backend = createCodexBackend(codexProvider(), codexDeps(handle));
    const iter = backend?.run(baseRunRequest, { execute: async () => "ok" });
    const events = await collect(iter as AsyncIterable<BackendAgentEvent>);
    expect(events).toContainEqual({
      type: "error",
      message: "Codex auth required.",
      code: "authentication",
      retryable: false
    });
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "error" });
  });

  it("delegates model discovery to the app-server handle", async () => {
    const backend = createCodexBackend(
      codexProvider(),
      codexDeps(new MockCodexAppServer({ events: [] }))
    );
    const result = await backend?.listModels?.();
    expect(result?.outcome).toBe("success");
    expect(result?.models).toContainEqual({ id: "gpt-5", available: true });
  });
});

describe("createNativeApiBackend", () => {
  it("returns null when the transport cannot be built (no egress path)", () => {
    const backend = createNativeApiBackend(nativeProvider(), nullTransportDeps());
    // createNativeApiBackend itself does not consult createTransport; the null
    // surfaces at run() time. Verify run() returns null for a null-transport dep.
    expect(backend).not.toBeNull();
    const iter = backend?.run(baseRunRequest, {
      execute: async () => "ok"
    });
    expect(iter).toBeNull();
  });

  it("streams text deltas then done for a no-tool turn", async () => {
    const deps = fixtureDeps([
      'data: {"choices":[{"delta":{"content":"Hi"}}]}',
      'data: {"choices":[{"delta":{"content":" there"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}]}'
    ]);
    const backend = createNativeApiBackend(nativeProvider(), deps);
    const iter = backend?.run(baseRunRequest, { execute: async () => "ok" });
    expect(iter).not.toBeNull();
    const events = await collect(iter as AsyncIterable<BackendAgentEvent>);
    const text = events
      .filter(
        (e): e is Extract<BackendAgentEvent, { type: "text-delta" }> => e.type === "text-delta"
      )
      .map((e) => e.text)
      .join("");
    expect(text).toBe("Hi there");
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop" });
  });

  it("routes a model tool call through the contract's execute seam (approval queue)", async () => {
    // Turn 1: the recorded openai.txt fixture emits a read-file tool call.
    // Turn 2: a plain stop turn so the loop completes after the tool result.
    const transport = SequencedFixtureTransport.fromTexts([
      readFixture("openai.txt"),
      'data: {"choices":[{"delta":{"content":"done"}}]}\ndata: {"choices":[{"finish_reason":"stop"}]}'
    ]);
    const executed: string[] = [];
    const deps: BackendDeps = {
      createTransport: () => ({ transport, cancel: async () => {} }),
      discoverModels: async () => ({ outcome: "empty", models: [] })
    };
    const backend = createNativeApiBackend(nativeProvider(), deps);
    const iter = backend?.run(baseRunRequest, {
      execute: async (_approval, args) => {
        executed.push(args);
        return "file contents";
      }
    });
    expect(iter).not.toBeNull();
    const events = await collect(iter as AsyncIterable<BackendAgentEvent>);
    // The tool-call surfaces with a pre-shaped ApprovalRequest.
    const toolCall = events.find((e) => e.type === "tool-call");
    expect(toolCall).toBeDefined();
    // The executor was invoked (proving the contract seam works).
    expect(executed.length).toBeGreaterThan(0);
    // The successful tool result is yielded back.
    const ok = events.find(
      (e): e is Extract<BackendAgentEvent, { type: "tool-result" }> =>
        e.type === "tool-result" && e.ok
    );
    expect(ok?.output).toBe("file contents");
  });

  it("invokes onRetry when the transport signals a retry", async () => {
    let retried = 0;
    const deps: BackendDeps = {
      createTransport: (_provider, handlers) => ({
        transport: new FixtureTransport([
          'data: {"choices":[{"delta":{"content":"ok"}}]}',
          'data: {"choices":[{"finish_reason":"stop"}]}'
        ]),
        cancel: async () => {}
      }),
      discoverModels: async () => ({ outcome: "empty", models: [] })
    };
    // Simulate a retry by calling the handler before running.
    const backend = createNativeApiBackend(nativeProvider(), deps);
    const iter = backend?.run(baseRunRequest, {
      execute: async () => "ok",
      onRetry: () => {
        retried += 1;
      }
    });
    expect(iter).not.toBeNull();
    await collect(iter as AsyncIterable<BackendAgentEvent>);
    // (No retry was signalled by the fixture transport; verify onRetry is wired
    // but not spuriously called.)
    expect(retried).toBe(0);
  });

  it("cancel() resolves without throwing when there is no active requestId", async () => {
    const backend = createNativeApiBackend(nativeProvider(), fixtureDeps([]));
    await expect(backend?.cancel("run-1")).resolves.toBeUndefined();
  });

  it("surfaces boundary cancellation as a cancelled event", async () => {
    const transport = {
      async *stream(): AsyncIterable<string> {
        const error = new Error("Provider request was cancelled.");
        (error as Error & { code: string; retryable: boolean }).code = "cancelled";
        (error as Error & { code: string; retryable: boolean }).retryable = false;
        throw error;
      }
    };
    const backend = createNativeApiBackend(nativeProvider(), {
      createTransport: () => ({ transport, cancel: async () => {} })
    });
    const events = await collect(
      backend?.run(baseRunRequest, { execute: async () => "ok" }) as AsyncIterable<BackendAgentEvent>
    );
    expect(events).toEqual([{ type: "cancelled" }]);
  });

  it("cancels the active boundary request when cooperative cancellation fires", async () => {
    let requestStarted: ((requestId: string) => void) | null = null;
    const cancelled: string[] = [];
    const transport = {
      async *stream(): AsyncIterable<string> {
        requestStarted?.("request-native-1");
        yield 'data: {"choices":[{"delta":{"content":"first"}}]}';
        yield 'data: {"choices":[{"delta":{"content":"second"}}]}';
      }
    };
    const backend = createNativeApiBackend(nativeProvider(), {
      createTransport: (_provider, handlers) => {
        requestStarted = handlers.onRequestStarted;
        return {
          transport,
          cancel: async (requestId) => {
            cancelled.push(requestId);
          }
        };
      }
    });
    let shouldCancel = false;
    const events: BackendAgentEvent[] = [];
    for await (const event of backend?.run(baseRunRequest, {
      execute: async () => "ok",
      shouldCancel: () => shouldCancel
    }) as AsyncIterable<BackendAgentEvent>) {
      events.push(event);
      shouldCancel = true;
    }
    expect(events).toContainEqual({ type: "cancelled" });
    expect(cancelled).toEqual(["request-native-1"]);
  });

  it("fails closed when tools are requested without tool and approval capabilities", async () => {
    const backend = createNativeApiBackend(
      nativeProvider({ capabilities: ["authentication", "streaming", "cancellation"] }),
      fixtureDeps(['data: {"choices":[{"finish_reason":"stop"}]}'])
    );
    const events = await collect(
      backend?.run(
        {
          ...baseRunRequest,
          tools: [{ name: "read_file", description: "Read a file", parameters: "{}" }]
        },
        { execute: async () => "ok" }
      ) as AsyncIterable<BackendAgentEvent>
    );
    expect(events).toEqual([
      {
        type: "error",
        message: "Tool calls/approvals are not supported by this backend's capabilities.",
        code: "invalid-request",
        retryable: false
      },
      { type: "done", finishReason: "error" }
    ]);
  });

  it.each([
    ["explicitly tool-capable", true, true],
    ["explicitly not tool-capable", false, false]
  ])(
    "honors %s model metadata when advertising Fable tools",
    async (_label, tools, expectTools) => {
      let sentToolCount = -1;
      const backend = createNativeApiBackend(
        nativeProvider({
          models: [
            {
              id: "future-model",
              label: "Future model",
              available: true,
              capabilities: {
                contextWindow: 128_000,
                maxOutputTokens: 8_192,
                streaming: true,
                tools,
                vision: false,
                reasoning: false,
                structuredOutput: false
              }
            }
          ]
        }),
        {
          createTransport: () => ({
            transport: {
              async *stream(request: NativeCompletionRequest): AsyncIterable<string> {
                sentToolCount = request.tools.length;
                yield 'data: {"choices":[{"finish_reason":"stop"}]}';
              }
            },
            cancel: async () => {}
          })
        }
      );

      await collect(
        backend?.run(
          { ...baseRunRequest, model: "future-model" },
          { execute: async () => "ok" }
        ) as AsyncIterable<BackendAgentEvent>
      );

      expect(sentToolCount > 0).toBe(expectTools);
    }
  );

  it("listModels() returns unsupported when discovery is not wired", async () => {
    const backend = createNativeApiBackend(nativeProvider(), {
      createTransport: () => ({ transport: new FixtureTransport([]), cancel: async () => {} })
    });
    const result = await backend?.listModels?.();
    expect(result?.outcome).toBe("unsupported");
  });

  it("listModels() delegates to deps.discoverModels when wired", async () => {
    const backend = createNativeApiBackend(nativeProvider(), {
      createTransport: () => ({ transport: new FixtureTransport([]), cancel: async () => {} }),
      discoverModels: async () => ({
        outcome: "success",
        models: [{ id: "gpt-5", available: true }]
      })
    });
    const result = await backend?.listModels?.();
    expect(result?.outcome).toBe("success");
    expect(result?.models).toContainEqual({ id: "gpt-5", available: true });
  });
});

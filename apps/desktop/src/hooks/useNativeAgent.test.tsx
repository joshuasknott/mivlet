import { act, renderHook, waitFor } from "@testing-library/react";
import { registeredToolSpecs } from "@fable/connectors/native-api/tools";
import type {
  AgentTurnRequest,
  BackendAgentEvent,
  BackendProvider,
  ExecutionAttempt,
  PreparedExecutionContext,
} from "@fable/protocol";
import { createApprovalGate } from "@fable/connectors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopToolExecutor } from "../lib/desktop-tool-runtime";
import type { DurableRunWriter } from "../lib/conversation-runtime";
import { agentPresence } from "../lib/agent-presence";
import { useNativeAgent } from "./useNativeAgent";

// This suite retains the direct wire-family and provider-owned runtime coverage.
// The embedded production bridge is exercised in useNativeAgent.embedded.test.tsx.
vi.mock("../lib/embedded-agent", () => ({ createDesktopEmbeddedRuntime: undefined }));

/**
 * useNativeAgent owns the agent run/cancel loop and the event-reduction state
 * machine. Outside Tauri the hook surfaces a no-transport notice; with a faked
 * desktop runtime the internal transport yields our scripted SSE lines through
 * the real runAgentLoop, so we drive the reduction deterministically and assert
 * the exact behaviors the goal targets:
 *   - text-delta accumulation into transcript
 *   - usage capture
 *   - tool-call -> onToolCall callback
 *   - error -> lastError
 *   - done/cancelled -> running=false
 *   - noTransport when hasDesktopRuntime() is false
 *
 * No real network, Tauri, or SSE — every Rust-bound wrapper is mocked. The
 * mocked listen callback captures onLine so tests can also hold an attempt open
 * (omit [DONE]) to exercise cancellation against a genuinely in-flight loop.
 */

const mocks = vi.hoisted(() => ({
  // SSE lines to feed the transport when it subscribes.
  lines: [] as string[],
  // Optional second-turn lines: when set, the first transport subscribe replays
  // `lines` and every subsequent subscribe replays `turnTwoLines` (defaulting to
  // a clean stop). This lets multi-turn joined tests script turn 1 (tool-call)
  // and turn 2 (stop) deterministically instead of replaying the same chunks.
  turnTwoLines: null as string[] | null,
  // When false, the listener does not emit [DONE] — the attempt stays open/blocked
  // so cancellation can target an in-flight loop.
  emitDone: true,
  // The most recent onLine callback, captured so a held-open run can be settled
  // manually after assertions.
  onLine: null as ((line: string) => void) | null,
  streamCalls: 0,
  // Every RuntimeStreamRequest the mocked streamRuntimeCompletion received. The
  // desktop transport calls it once per turn with `{ providerId, requestId,
  // model, body }` where `body` is the output of shapeBodyFor(request). Capturing
  // it lets the per-provider routing tests assert that each provider's body was
  // shaped by the right shaper (anthropic/gemini/openai-compat) before egress —
  // proving the shapeBodyFor routing works end-to-end through the desktop hook.
  streamRequests: [] as Array<{
    providerId: string;
    requestId: string;
    model: string;
    body: unknown;
    providerRoute?: unknown;
  }>,
  cancelCalls: [] as string[],
  // The joined integration test scripts the mocked Rust tool boundary here:
  // every executeRuntimeToolCall records its request and resolves with this result.
  toolRequests: [] as unknown[],
  savedRuns: [] as unknown[],
  persistenceEvents: [] as string[],
  saveError: null as Error | null,
  failSaveStatus: null as ExecutionAttempt["status"] | null,
  recoveredRuns: [] as ExecutionAttempt[],
  listedRuns: null as ExecutionAttempt[] | null,
  codexEvents: [] as unknown[],
  codexListener: null as ((event: unknown) => void) | null,
  toolResult: { ok: true, output: "Fetched body text from Rust." },
  selectRoute: vi.fn(async (input: { providerId: string; model: string }) => ({
    workspaceId: "workspace-1",
    selection: {
      providerRouteId: `route-${input.providerId}-${input.model}`,
      selectedAt: "2026-07-12T12:00:00.000Z",
      reason: `Selected ${input.providerId} ${input.model}.`,
      boundaryPolicyRef: `boundary-${input.providerId}`,
    },
  })),
}));

vi.mock("../lib/provider-route-selection", () => ({
  selectNativeProviderRoute: mocks.selectRoute,
}));

vi.mock("../runtime", () => ({
  listenRuntimeBackendEvents: vi.fn(
    async (_requestId: string, onLine: (line: string) => void) => {
      mocks.onLine = onLine;
      const subscribeCount = ++listenCount;
      // Turn 1 plays `lines`; turn 2+ plays `turnTwoLines` (a clean stop by default)
      // so a multi-turn run does not replay the tool-call chunks each turn.
      const replay =
        subscribeCount > 1 && mocks.turnTwoLines !== null
          ? mocks.turnTwoLines
          : mocks.lines;
      for (const line of replay) {
        onLine(line);
      }
      if (mocks.emitDone) {
        onLine("[DONE]");
      }
      return () => {};
    },
  ),
  streamRuntimeCompletion: vi.fn(
    async (request: {
      providerId: string;
      requestId: string;
      model: string;
      body: unknown;
      providerRoute?: unknown;
    }) => {
      mocks.streamCalls += 1;
      mocks.persistenceEvents.push("egress");
      // Record the egress request so the per-provider routing tests can assert
      // the body was shaped by the correct shaper before crossing to Rust.
      mocks.streamRequests.push(request);
      return null;
    },
  ),
  cancelRuntimeCompletion: vi.fn(async (requestId: string) => {
    mocks.cancelCalls.push(requestId);
    return null;
  }),
  saveRuntimeExecutionAttempt: vi.fn(async (run: unknown) => {
    if (mocks.saveError) throw mocks.saveError;
    if (
      mocks.failSaveStatus &&
      (run as ExecutionAttempt).status === mocks.failSaveStatus
    )
      throw new Error("final persistence unavailable");
    mocks.savedRuns.push(run);
    mocks.persistenceEvents.push("save");
    return run;
  }),
  recoverRuntimeExecutionAttempts: vi.fn(async () => mocks.recoveredRuns),
  listRuntimeExecutionAttempts: vi.fn(async () => mocks.listedRuns),
  listRuntimeBackendModels: vi.fn(async () => null),
  executeRuntimeToolCall: vi.fn(async (request: unknown) => {
    mocks.toolRequests.push(request);
    return mocks.toolResult;
  }),
  listenRuntimeCodexEvents: vi.fn(
    async (_requestId: string, onEvent: (event: unknown) => void) => {
      mocks.codexListener = onEvent;
      return () => {
        mocks.codexListener = null;
      };
    },
  ),
  startRuntimeCodexTurn: vi.fn(async () => {
    for (const event of mocks.codexEvents) mocks.codexListener?.(event);
    return null;
  }),
  respondRuntimeCodexApproval: vi.fn(async () => null),
  interruptRuntimeCodexTurn: vi.fn(async () => null),
  shutdownRuntimeCodexTurn: vi.fn(async () => null),
  getRuntimeCodexStatus: vi.fn(async () => ({
    installed: true,
    authenticated: true,
    authMethod: "chatgpt",
  })),
}));

// Tracks the number of transport subscribes so the mock can serve different
// lines per turn (declared outside the hoisted block so it is mutable + reset).
let listenCount = 0;

/** Set window.__TAURI_INTERNALS__ so hasDesktopRuntime() returns true. */
function installDesktopRuntime() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: { invoke: {} },
    configurable: true,
    writable: true,
  });
}

/** Clear any faked desktop runtime so hasDesktopRuntime() returns false. */
function removeDesktopRuntime() {
  try {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__;
  } catch {}
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
    undefined;
}

const baseRequest: AgentTurnRequest = {
  model: "gpt-5",
  messages: [{ role: "user", content: "summarize the conversation" }],
  tools: [],
  maxTokens: 1024,
};

const preparedContext: PreparedExecutionContext = {
  systemPrefix: "Use the selected conversation notes.",
  receipt: {
    version: 1,
    attemptId: "019f4f00-0000-7000-8000-contextreceipt",
    assembledAt: "2026-07-11T12:00:00.000Z",
    scope: { level: "thread", threadId: "thread-1" },
    citations: [],
    contributions: [
      { id: "memory-1", kind: "memory", reason: "memory-approved" },
    ],
  },
};

/** A connected, streaming native-API provider the hook can resolve to a backend. */
function connectedOpenAiProvider(): BackendProvider {
  return {
    id: "openai",
    backendType: "native-api",
    label: "OpenAI",
    description: "OpenAI API",
    authState: "connected",
    capabilities: [
      "authentication",
      "streaming",
      "tool-requests",
      "approvals",
      "cancellation",
    ],
    models: [{ id: "gpt-5", label: "GPT-5", available: true }],
  };
}

function connectedCodexProvider(): BackendProvider {
  return {
    id: "codex",
    backendType: "codex-app-server",
    label: "Codex",
    description: "Codex app-server",
    authState: "connected",
    capabilities: [
      "authentication",
      "threads",
      "streaming",
      "tool-requests",
      "approvals",
      "cancellation",
    ],
    models: [{ id: "gpt-5", label: "GPT-5", available: true }],
  };
}

function openAiChunk(delta: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}`;
}
const finishStop = 'data: {"choices":[{"finish_reason":"stop"}]}';

function resetLineState() {
  mocks.lines = [];
  mocks.turnTwoLines = null;
  mocks.emitDone = true;
  mocks.onLine = null;
  mocks.streamCalls = 0;
  mocks.streamRequests = [];
  mocks.cancelCalls = [];
  mocks.toolRequests = [];
  mocks.savedRuns = [];
  mocks.persistenceEvents = [];
  mocks.saveError = null;
  mocks.failSaveStatus = null;
  mocks.recoveredRuns = [];
  mocks.listedRuns = null;
  mocks.codexEvents = [];
  mocks.codexListener = null;
  mocks.toolResult = { ok: true, output: "Fetched body text from Rust." };
  listenCount = 0;
}

describe("useNativeAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLineState();
    removeDesktopRuntime();
  });

  it("delivers voice text only after the matching durable assistant checkpoint", async () => {
    installDesktopRuntime();
    mocks.lines = [openAiChunk("Hello. "), openAiChunk("Ready."), finishStop];
    const events: string[] = [];
    const { result } = renderHook(() => useNativeAgent({
      providers: [connectedOpenAiProvider()], threadId: "thread-1",
      createDurableRunWriter: () => ({ record: vi.fn(async () => {}), checkpointAssistant: async (text) => { events.push(`saved:${text}`); } }),
    }));
    await act(async () => { await result.current.run(baseRequest, undefined, undefined, undefined, { onTextDelta: (text) => events.push(`voice:${text}`) }); });
    expect(events).toContain("voice:Hello. ");
    expect(events.indexOf("saved:Hello. ")).toBeLessThan(events.indexOf("voice:Hello. "));
    expect(events.indexOf("saved:Hello. Ready.")).toBeLessThan(events.indexOf("voice:Ready."));
  });

  it("does not speak a reply that failed its durable checkpoint", async () => {
    installDesktopRuntime(); mocks.lines = [openAiChunk("Unsaved reply."), finishStop];
    const onTextDelta = vi.fn();
    const { result } = renderHook(() => useNativeAgent({
      providers: [connectedOpenAiProvider()], threadId: "thread-1",
      createDurableRunWriter: () => ({ record: vi.fn(async () => {}), checkpointAssistant: async () => { throw new Error("Disk unavailable"); } }),
    }));
    await act(async () => { await result.current.run(baseRequest, undefined, undefined, undefined, { onTextDelta }); });
    expect(onTextDelta).not.toHaveBeenCalled();
    expect(result.current.state.status).toBe("failed");
  });

  it("continues from local conversation history without duplicating it in storage", async () => {
    installDesktopRuntime();
    mocks.lines = [openAiChunk("Elm"), finishStop];
    const record = vi.fn(
      async (_entry: Parameters<DurableRunWriter["record"]>[0]) => {},
    );
    const loadConversation = vi.fn(
      async () =>
        ({
          thread: { id: "thread-1" },
          messages: [
            {
              message: { kind: "user", sequence: 1 },
              currentRevision: {
                state: "terminal",
                content: "The project is Elm.",
              },
            },
            {
              message: { kind: "assistant", sequence: 2 },
              currentRevision: {
                state: "terminal",
                content: "I'll remember Elm.",
              },
            },
            {
              message: {
                kind: "tool",
                sequence: 3,
                detail: {
                  phase: "call",
                  toolCallId: "old-write",
                  toolName: "write-file",
                },
              },
              currentRevision: { state: "terminal", content: "Old action" },
            },
          ],
        }) as never,
    );
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedOpenAiProvider()],
        threadId: "thread-1",
        loadConversation,
        createDurableRunWriter: () => ({
          record,
          checkpointAssistant: vi.fn(async () => {}),
        }),
      }),
    );
    await act(async () => {
      await result.current.run({
        ...baseRequest,
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "What is the project called?" },
        ],
      });
    });
    const messages = (
      mocks.streamRequests[0].body as {
        messages: Array<{ role: string; content: string }>;
      }
    ).messages;
    expect(messages.filter((message) => message.role !== "system")).toEqual([
      { role: "user", content: "The project is Elm." },
      { role: "assistant", content: "I'll remember Elm." },
      { role: "user", content: "What is the project called?" },
    ]);
    expect(
      messages.some(
        (message) =>
          message.role === "system" && message.content.includes("Be concise."),
      ),
    ).toBe(true);
    expect(
      record.mock.calls.filter(([entry]) => entry.kind === "user"),
    ).toEqual([[{ kind: "user", content: "What is the project called?" }]]);
    const saved = mocks.savedRuns.at(-1) as ExecutionAttempt;
    expect(saved.exchanges?.filter((entry) => entry.role === "user")).toEqual([
      {
        role: "user",
        content: "What is the project called?",
        toolCallId: undefined,
        toolName: undefined,
      },
    ]);
    expect(JSON.stringify(saved)).not.toContain("Be concise.");
  });

  it("refuses history from a different thread before persistence or egress", async () => {
    installDesktopRuntime();
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedOpenAiProvider()],
        threadId: "thread-1",
        loadConversation: async () =>
          ({ thread: { id: "thread-2" }, messages: [] }) as never,
      }),
    );
    await act(async () => {
      await result.current.run(baseRequest);
    });
    expect(result.current.state.lastError).toContain("conversation changed");
    expect(mocks.savedRuns).toHaveLength(0);
    expect(mocks.streamCalls).toBe(0);
  });

  it("rejects oversized Codex history before optimistic persistence or egress", async () => {
    installDesktopRuntime();
    const record = vi.fn(async () => undefined);
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedCodexProvider()],
        activeProviderId: "codex",
        computer: { workspaceId: "workspace-1", agentId: "agent-1" },
        contextOwner: { internalUserId: "user-1", memberId: "member-1" },
        threadId: "thread-1",
        loadConversation: async () =>
          ({
            thread: { id: "thread-1" },
            messages: [
              {
                message: { kind: "user", sequence: 1 },
                currentRevision: {
                  state: "terminal",
                  content: "x".repeat(70 * 1024),
                },
              },
            ],
          }) as never,
        createDurableRunWriter: () => ({
          record,
          checkpointAssistant: vi.fn(async () => undefined),
        }),
      }),
    );

    await act(async () => {
      await result.current.run({ ...baseRequest, model: "gpt-5" });
    });

    expect(result.current.state.contextFailure).toMatchObject({
      reason: "native-history-envelope",
      requestPrompt: "summarize the conversation",
      capacitySource: "unavailable",
      nativeHistoryMaxUtf8Bytes: 64 * 1024,
      scope: {
        workspaceId: "workspace-1",
        agentId: "agent-1",
        threadId: "thread-1",
        ownerInternalUserId: "user-1",
        ownerMemberId: "member-1",
      },
    });
    expect(result.current.state.lastError).toContain("Codex history envelope");
    expect(record).not.toHaveBeenCalled();
    expect(mocks.savedRuns).toHaveLength(0);
    expect(mocks.codexListener).toBeNull();

    act(() => result.current.clearError());
    expect(result.current.state.contextFailure).toBeUndefined();
    expect(result.current.state.lastError).toBeNull();
  });

  it("clears a context failure when only its account owner changes", async () => {
    installDesktopRuntime();
    const { result, rerender } = renderHook(
      ({ internalUserId, memberId }) => useNativeAgent({
        providers: [connectedCodexProvider()],
        activeProviderId: "codex",
        computer: { workspaceId: "workspace-1", agentId: "agent-1" },
        contextOwner: { internalUserId, memberId },
        threadId: "thread-1",
        loadConversation: async (id) => ({
          thread: { id },
          messages: [{
            message: { kind: "user", sequence: 1 },
            currentRevision: { state: "terminal", content: "x".repeat(70 * 1024) },
          }],
        }) as never,
      }),
      { initialProps: { internalUserId: "user-1", memberId: "member-1" } },
    );
    await act(async () => { await result.current.run(baseRequest); });
    expect(result.current.state.contextFailure?.scope.threadId).toBe("thread-1");

    rerender({ internalUserId: "user-2", memberId: "member-2" });
    await waitFor(() => expect(result.current.state.contextFailure).toBeUndefined());
    expect(result.current.state.lastError).toBeNull();
  });

  it("does not publish a late context result after the request scope changes", async () => {
    installDesktopRuntime();
    let release: ((value: never) => void) | undefined;
    const loadConversation = vi.fn(() => new Promise<never>((resolve) => { release = resolve; }));
    const { result, rerender } = renderHook(
      ({ internalUserId, memberId }) => useNativeAgent({
        providers: [connectedCodexProvider()],
        activeProviderId: "codex",
        computer: { workspaceId: "workspace-1", agentId: "agent-1" },
        contextOwner: { internalUserId, memberId },
        threadId: "thread-1",
        loadConversation,
      }),
      { initialProps: { internalUserId: "user-1", memberId: "member-1" } },
    );
    let pending!: Promise<ExecutionAttempt | undefined>;
    act(() => { pending = result.current.run(baseRequest); });
    await waitFor(() => expect(loadConversation).toHaveBeenCalledWith("thread-1"));
    expect(result.current.getActiveAttemptId()).not.toBeNull();
    rerender({ internalUserId: "user-2", memberId: "member-2" });
    await act(async () => { await result.current.cancel(); });
    expect(result.current.getActiveAttemptId()).toBeNull();
    await act(async () => {
      release?.(({ thread: { id: "thread-1" }, messages: [] }) as never);
      await pending;
    });
    expect(result.current.state.contextFailure).toBeUndefined();
    expect(result.current.state.lastError).toBeNull();
    expect(mocks.savedRuns).toHaveLength(0);
    expect(mocks.codexListener).toBeNull();
  });

  it("surfaces noTransport and an error when no desktop runtime is present", async () => {
    const { result } = renderHook(() =>
      useNativeAgent({ providers: [{ id: "openai" } as never] }),
    );

    // The initial state reflects the missing runtime.
    expect(result.current.state.noTransport).toBe(true);

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(result.current.state.noTransport).toBe(true);
    expect(result.current.state.lastError).toBe(
      "Native agent needs the desktop runtime.",
    );
    expect(result.current.state.running).toBe(false);
    // No transport means no stream ever started.
    expect(mocks.streamCalls).toBe(0);
  });

  it("resolves an already-connected backend independently of the active picker", async () => {
    const anthropic: BackendProvider = {
      ...connectedOpenAiProvider(),
      id: "anthropic",
      label: "Anthropic",
      description: "Anthropic API",
      models: [
        { id: "claude-sonnet-4", label: "Claude Sonnet 4", available: true },
      ],
    };
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedOpenAiProvider(), anthropic],
        activeProviderId: "openai",
      }),
    );

    await waitFor(() =>
      expect(result.current.backend?.providerId).toBe("openai"),
    );
    expect(result.current.resolveBackend("anthropic")?.providerId).toBe(
      "anthropic",
    );
    expect(result.current.resolveBackend("missing")).toBeNull();
  });

  it("persists the immutable prepared receipt before egress and uses its canonical attempt id", async () => {
    installDesktopRuntime();
    mocks.lines = [openAiChunk("Done"), finishStop];
    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] }),
    );
    await act(async () => {
      await result.current.run(baseRequest, preparedContext);
    });
    const saved = mocks.savedRuns as ExecutionAttempt[];
    expect(saved[0]).toMatchObject({
      id: preparedContext.receipt.attemptId,
      contextReceipt: preparedContext.receipt,
      status: "queued",
    });
    expect(mocks.persistenceEvents[0]).toBe("save");
    expect(mocks.persistenceEvents.indexOf("save")).toBeLessThan(
      mocks.persistenceEvents.indexOf("egress"),
    );
    expect(
      saved.every((run) => run.contextReceipt === preparedContext.receipt),
    ).toBe(true);
    expect(mocks.streamRequests[0]).toBeDefined();
    expect(saved[0].providerRoute).toMatchObject({
      workspaceId: "workspace-1",
      selection: { providerRouteId: "route-openai-gpt-5" },
    });
    expect(mocks.streamRequests[0].providerRoute).toEqual(
      saved[0].providerRoute,
    );
    expect(
      result.current.state.providerRoutes[preparedContext.receipt.attemptId],
    ).toEqual(saved[0].providerRoute);
    expect(
      result.current.state.contextReceipts[preparedContext.receipt.attemptId],
    ).toEqual(preparedContext.receipt);
  });

  it("binds a persisted queued attempt before canonical user persistence and egress", async () => {
    installDesktopRuntime();
    mocks.lines = [openAiChunk("Done"), finishStop];
    const order: string[] = [];
    const record = vi.fn(
      async (_entry: Parameters<DurableRunWriter["record"]>[0]) => {
        order.push("canonical-user");
      },
    );
    const afterAttemptQueued = vi.fn(async () => {
      expect((mocks.savedRuns[0] as ExecutionAttempt).status).toBe("queued");
      expect(mocks.streamCalls).toBe(0);
      order.push("project-bind");
    });
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedOpenAiProvider()],
        threadId: "thread-1",
        models: [
          {
            id: "gpt-5",
            label: "GPT-5",
            available: true,
            capabilities: {
              contextWindow: 128_000,
              maxOutputTokens: 8_192,
              streaming: true,
              tools: true,
              vision: false,
              reasoning: true,
              structuredOutput: true,
            },
          },
        ],
        createDurableRunWriter: () => ({
          record,
          checkpointAssistant: vi.fn(async () => {}),
        }),
      }),
    );

    await act(async () => {
      await result.current.run(
        baseRequest,
        preparedContext,
        undefined,
        undefined,
        { afterAttemptQueued },
      );
    });

    expect((mocks.savedRuns[0] as ExecutionAttempt).status).toBe("queued");
    expect(afterAttemptQueued).toHaveBeenCalledWith({
      attemptId: preparedContext.receipt.attemptId,
      threadId: "thread-1",
    });
    expect(mocks.persistenceEvents[0]).toBe("save");
    expect(order).toEqual(["project-bind", "canonical-user"]);
    expect(mocks.persistenceEvents.indexOf("egress")).toBeGreaterThan(0);
  });

  it("fails closed when queued project binding fails", async () => {
    installDesktopRuntime();
    const record = vi.fn(
      async (_entry: Parameters<DurableRunWriter["record"]>[0]) => {},
    );
    const afterAttemptQueued = vi.fn(async () => {
      throw new Error("project author binding rejected");
    });
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedOpenAiProvider()],
        threadId: "thread-1",
        models: [
          {
            id: "gpt-5",
            label: "GPT-5",
            available: true,
            capabilities: {
              contextWindow: 128_000,
              maxOutputTokens: 8_192,
              streaming: true,
              tools: true,
              vision: false,
              reasoning: true,
              structuredOutput: true,
            },
          },
        ],
        createDurableRunWriter: () => ({
          record,
          checkpointAssistant: vi.fn(async () => {}),
        }),
      }),
    );

    let outcome: ExecutionAttempt | undefined;
    await act(async () => {
      outcome = await result.current.run(
        baseRequest,
        preparedContext,
        undefined,
        undefined,
        { afterAttemptQueued },
      );
    });

    expect((mocks.savedRuns[0] as ExecutionAttempt).status).toBe("queued");
    expect((mocks.savedRuns.at(-1) as ExecutionAttempt).status).toBe("failed");
    expect(outcome?.status).toBe("failed");
    expect(result.current.state.lastError).toContain(
      "project author binding rejected",
    );
    expect(record).not.toHaveBeenCalled();
    expect(mocks.streamCalls).toBe(0);
  });

  it("suppresses only the synthetic canonical user record while retaining its execution exchange", async () => {
    installDesktopRuntime();
    mocks.lines = [openAiChunk("Analyst result"), finishStop];
    const record = vi.fn(
      async (_entry: Parameters<DurableRunWriter["record"]>[0]) => {},
    );
    const checkpointAssistant = vi.fn(async () => {});
    const syntheticRequest: AgentTurnRequest = {
      ...baseRequest,
      messages: [
        {
          role: "user",
          content: "Internal contribution: analyze the project evidence.",
        },
      ],
    };
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedOpenAiProvider()],
        threadId: "thread-1",
        createDurableRunWriter: () => ({ record, checkpointAssistant }),
      }),
    );

    let outcome: ExecutionAttempt | undefined;
    await act(async () => {
      outcome = await result.current.run(
        syntheticRequest,
        preparedContext,
        undefined,
        undefined,
        { canonicalUserMessage: "suppress" },
      );
    });

    expect(outcome?.exchanges?.[0]).toMatchObject({
      role: "user",
      content: "Internal contribution: analyze the project evidence.",
    });
    expect(record.mock.calls.some(([entry]) => entry.kind === "user")).toBe(
      false,
    );
    expect(checkpointAssistant).toHaveBeenCalled();
    expect(JSON.stringify(mocks.streamRequests[0])).toContain(
      "Internal contribution: analyze the project evidence.",
    );
  });

  it("binds submitted attachment metadata to the canonical user record", async () => {
    installDesktopRuntime();
    mocks.lines = [openAiChunk("Done"), finishStop];
    const record = vi.fn(async (_entry: Parameters<DurableRunWriter["record"]>[0]) => {});
    const { result } = renderHook(() => useNativeAgent({
      providers: [connectedOpenAiProvider()],
      threadId: "thread-1",
      createDurableRunWriter: () => ({ record, checkpointAssistant: vi.fn(async () => {}) }),
    }));
    await act(async () => {
      await result.current.run(baseRequest, preparedContext, undefined, undefined, {
        attachments: [{ id: "attachment-1", name: "totals.csv", mimeType: "text/csv", sizeBytes: 24, availability: "workspace-file", relativePath: "Attachments/totals-a1.csv" }],
      });
    });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      kind: "user",
      attachments: [expect.objectContaining({ relativePath: "Attachments/totals-a1.csv" })],
    }));
    expect((mocks.savedRuns[0] as ExecutionAttempt).exchanges?.[0].attachments).toEqual([
      expect.objectContaining({ relativePath: "Attachments/totals-a1.csv" }),
    ]);
  });

  it("reloads canonical project history for each sequential contribution", async () => {
    installDesktopRuntime();
    mocks.lines = [openAiChunk("Current contribution"), finishStop];
    let loadCount = 0;
    const loadConversation = vi.fn(async () => {
      loadCount += 1;
      return {
        thread: { id: "thread-project" },
        messages:
          loadCount === 1
            ? []
            : [
                {
                  message: {
                    kind: "assistant",
                    sequence: 1,
                    runId: "first-agent-attempt",
                  },
                  currentRevision: {
                    state: "terminal",
                    content: "The first agent found the launch risk.",
                  },
                },
              ],
      } as never;
    });
    const writerAttemptIds: string[] = [];
    const record = vi.fn(
      async (_entry: Parameters<DurableRunWriter["record"]>[0]) => {},
    );
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedOpenAiProvider()],
        threadId: "thread-project",
        loadConversation,
        createDurableRunWriter: (_threadId, attemptId) => {
          writerAttemptIds.push(attemptId);
          return {
            record,
            checkpointAssistant: vi.fn(async () => {}),
          };
        },
      }),
    );

    await act(async () => {
      await result.current.run(
        {
          ...baseRequest,
          messages: [{ role: "user", content: "First internal handoff" }],
        },
        undefined,
        undefined,
        undefined,
        { canonicalUserMessage: "suppress" },
      );
      await result.current.run(
        {
          ...baseRequest,
          messages: [{ role: "user", content: "Second internal handoff" }],
        },
        undefined,
        undefined,
        undefined,
        { canonicalUserMessage: "suppress" },
      );
    });

    expect(loadConversation).toHaveBeenCalledTimes(2);
    expect(new Set(writerAttemptIds).size).toBe(2);
    const secondMessages = (
      mocks.streamRequests[1].body as {
        messages: Array<{ role: string; content: string }>;
      }
    ).messages;
    expect(secondMessages).toEqual(
      expect.arrayContaining([
        {
          role: "assistant",
          content: "The first agent found the launch risk.",
        },
        { role: "user", content: "Second internal handoff" },
      ]),
    );
    expect(secondMessages).not.toEqual(
      expect.arrayContaining([
        { role: "user", content: "First internal handoff" },
      ]),
    );
    expect(record.mock.calls.some(([entry]) => entry.kind === "user")).toBe(
      false,
    );
  });

  it("rechecks cancellation after awaiting queued project binding", async () => {
    installDesktopRuntime();
    let cancelled = false;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const afterAttemptQueued = vi.fn(() => waiting);
    const record = vi.fn(
      async (_entry: Parameters<DurableRunWriter["record"]>[0]) => {},
    );
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedOpenAiProvider()],
        threadId: "thread-1",
        shouldCancel: () => cancelled,
        createDurableRunWriter: () => ({
          record,
          checkpointAssistant: vi.fn(async () => {}),
        }),
      }),
    );

    let running!: Promise<ExecutionAttempt | undefined>;
    act(() => {
      running = result.current.run(
        baseRequest,
        preparedContext,
        undefined,
        undefined,
        { afterAttemptQueued },
      );
    });
    await waitFor(() => expect(afterAttemptQueued).toHaveBeenCalledOnce());
    cancelled = true;
    release();
    await act(async () => {
      await running;
    });

    expect((mocks.savedRuns.at(-1) as ExecutionAttempt).status).toBe(
      "cancelled",
    );
    expect(record).not.toHaveBeenCalled();
    expect(mocks.streamCalls).toBe(0);
  });

  it("creates an explicit empty receipt when a caller has no prepared context", async () => {
    installDesktopRuntime();
    mocks.lines = [finishStop];
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedOpenAiProvider()],
        threadId: "thread-1",
      }),
    );
    await act(async () => {
      await result.current.run(baseRequest);
    });
    const first = mocks.savedRuns[0] as ExecutionAttempt;
    expect(first.contextReceipt).toMatchObject({
      attemptId: first.id,
      scope: { level: "thread", threadId: "thread-1" },
      citations: [],
      contributions: [],
    });
  });

  it("binds a new Codex turn to the saved computer scope after hydration changes it", async () => {
    installDesktopRuntime();
    mocks.codexEvents = [{ type: "done", finishReason: "stop" }];
    const providers = [connectedCodexProvider()];
    const { result, rerender } = renderHook(
      ({ agentId }) =>
        useNativeAgent({
          providers,
          computer: { workspaceId: "workspace-1", agentId },
        }),
      { initialProps: { agentId: "initial-placeholder" } },
    );
    rerender({ agentId: "saved-agent" });
    await act(async () => {
      await result.current.run(baseRequest);
    });
    const { startRuntimeCodexTurn } = await import("../runtime");
    expect(startRuntimeCodexTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          computer: { workspaceId: "workspace-1", agentId: "saved-agent" },
        }),
      }),
    );
  });

  it("clears completed presentation when the selected agent scope changes", async () => {
    installDesktopRuntime();
    mocks.codexEvents = [{ type: "done", finishReason: "stop" }];
    const { result, rerender } = renderHook(
      ({ agentId }) => useNativeAgent({
        providers: [connectedCodexProvider()],
        threadId: "thread-a",
        computer: { workspaceId: "workspace-1", agentId },
      }),
      { initialProps: { agentId: "agent-a" } },
    );
    await act(async () => { await result.current.run(baseRequest); });
    expect(result.current.state.status).toBe("completed");
    expect(result.current.state.progressAgentId).toBe("agent-a");

    rerender({ agentId: "agent-b" });
    await waitFor(() => expect(result.current.state.status).toBe("idle"));
    expect(result.current.state.currentAttemptId).toBeNull();
    expect(result.current.state.progressAgentId).toBeUndefined();
    expect(result.current.state.transcript).toBe("");
  });

  it("persists image metadata without transient pixels", async () => {
    installDesktopRuntime();
    mocks.codexEvents = [{ type: "done", finishReason: "stop" }];
    const record = vi.fn(
      async (_entry: Parameters<DurableRunWriter["record"]>[0]) => {},
    );
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedCodexProvider()],
        threadId: "thread-image",
        createDurableRunWriter: () => ({
          record,
          checkpointAssistant: vi.fn(async () => {}),
        }),
      }),
    );
    let outcome: ExecutionAttempt | null | undefined;
    await act(async () => {
      outcome = await result.current.run({
        ...baseRequest,
        messages: [
          {
            role: "user",
            content: "Describe this image",
            images: [
              {
                id: "image-1",
                name: "pixel.png",
                mediaType: "image/png",
                sizeBytes: 68,
                width: 1,
                height: 1,
                dataUrl: "data:image/png;base64,private-pixels",
              },
            ],
          },
        ],
      });
    });
    expect(outcome?.status).toBe("completed");
    const first = mocks.savedRuns[0] as ExecutionAttempt;
    expect(first.exchanges?.[0].images).toEqual([
      {
        id: "image-1",
        name: "pixel.png",
        mediaType: "image/png",
        sizeBytes: 68,
        width: 1,
        height: 1,
      },
    ]);
    expect(JSON.stringify(mocks.savedRuns)).not.toContain("private-pixels");
    expect(record).toHaveBeenCalledWith({
      kind: "user",
      content: "Describe this image",
    });
    expect(JSON.stringify(record.mock.calls)).not.toContain("private-pixels");
  });

  it("removes optimistic receipt evidence when the pre-egress save fails", async () => {
    installDesktopRuntime();
    mocks.saveError = new Error("disk unavailable");
    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] }),
    );
    await act(async () => {
      await result.current.run(baseRequest, preparedContext);
    });
    expect(mocks.streamCalls).toBe(0);
    expect(
      result.current.state.contextReceipts[preparedContext.receipt.attemptId],
    ).toBeUndefined();
    expect(
      result.current.state.providerRoutes[preparedContext.receipt.attemptId],
    ).toBeUndefined();
    expect(result.current.state.currentAttemptId).toBeNull();
  });

  it("hydrates context receipts for completed, failed, and interrupted historical runs", async () => {
    installDesktopRuntime();
    mocks.listedRuns = (["completed", "failed", "interrupted"] as const).map(
      (status, index) => ({
        id: `attempt-${status}`,
        providerId: "openai",
        model: "gpt-5",
        status,
        transcript: "response",
        turn: 0,
        pendingApprovalIds: [],
        recoverable: status !== "completed",
        retryCount: 0,
        createdAt: "2026-07-11T12:00:00.000Z",
        updatedAt: "2026-07-11T12:00:01.000Z",
        contextReceipt: {
          ...preparedContext.receipt,
          attemptId: `attempt-${status}`,
          contributions: [
            {
              id: `item-${index}`,
              kind: "source" as const,
              reason: "retrieved" as const,
            },
          ],
        },
        providerRoute: {
          workspaceId: "workspace-1" as never,
          selection: {
            providerRouteId: `route-${status}` as never,
            selectedAt: "2026-07-12T12:00:00Z" as never,
            reason: `Selected route ${status}.`,
          },
        },
        usage: {
          inputTokens: 40 + index,
          outputTokens: 5 + index,
          costUsd: 0,
          costUnknown: true,
        },
        reasoningSummaries: { public: `Summary for ${status}` },
      }),
    );
    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] }),
    );
    await waitFor(() =>
      expect(Object.keys(result.current.state.contextReceipts)).toHaveLength(3),
    );
    expect(
      result.current.state.contextReceipts["attempt-interrupted"]
        ?.contributions[0].reason,
    ).toBe("retrieved");
    expect(
      result.current.state.providerRoutes["attempt-completed"]?.selection
        .reason,
    ).toBe("Selected route completed.");
    expect(result.current.state.usageReceipts["attempt-failed"]).toMatchObject({
      inputTokens: 41,
      outputTokens: 6,
      costUnknown: true,
    });
    expect(
      result.current.state.progressReceipts?.["attempt-completed"].summaries,
    ).toEqual({ public: "Summary for completed" });
  });

  it("surfaces interrupted runs and retries from the durable user prompt", async () => {
    installDesktopRuntime();
    mocks.recoveredRuns = [
      {
        id: "attempt-interrupted",
        providerId: "openai",
        model: "gpt-5",
        status: "interrupted",
        transcript: "partial",
        threadId: "thread-1",
        exchanges: [
          { role: "user", content: "Resume this safely" },
          {
            role: "tool",
            content: "already wrote the file",
            toolCallId: "call-completed",
            toolName: "write-file",
            ok: true,
          },
        ],
        turn: 0,
        pendingApprovalIds: [],
        recoverable: true,
        retryCount: 0,
        createdAt: "2026-06-28T10:00:00Z",
        updatedAt: "2026-06-28T10:01:00Z",
      },
    ];
    mocks.lines = [openAiChunk("Recovered"), finishStop];

    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedOpenAiProvider()],
        threadId: "thread-1",
        models: [
          {
            id: "gpt-5",
            label: "GPT-5",
            available: true,
            capabilities: {
              contextWindow: 128_000,
              maxOutputTokens: 8_192,
              streaming: true,
              tools: true,
              vision: false,
              reasoning: true,
              structuredOutput: true,
            },
          },
        ],
      }),
    );
    await waitFor(() =>
      expect(result.current.state.recoverableAttempts).toHaveLength(1),
    );

    await act(async () => {
      await result.current.retry(
        result.current.state.recoverableAttempts[0],
        registeredToolSpecs().filter((tool) => tool.name === "gmail-read"),
        "read-only",
        "Use the isolated agent computer. Verify each result before continuing.",
      );
    });

    expect(result.current.state.transcript).toBe("Recovered");
    expect(mocks.streamRequests[0].body).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("Use the isolated agent computer."),
        }),
      ]),
    });
    expect(mocks.streamRequests[0].body).toMatchObject({
      tools: [
        expect.objectContaining({
          function: expect.objectContaining({ name: "gmail-read" }),
        }),
      ],
    });
    expect(result.current.state.recoverableAttempts).toHaveLength(0);
    const finalRun = mocks.savedRuns.at(-1) as ExecutionAttempt;
    expect(finalRun.parentAttemptId).toBe("attempt-interrupted");
    expect(finalRun.threadId).toBe("thread-1");
    expect(
      finalRun.exchanges?.find((exchange) => exchange.role === "user"),
    ).toEqual({
      role: "user",
      content: "Resume this safely",
      toolCallId: undefined,
      toolName: undefined,
    });
    // A retry starts a child attempt from the safe user turn; it does not replay
    // a completed tool call from the parent as a new side effect.
    const retryMessages = (
      mocks.streamRequests[0].body as {
        messages: Array<{ role: string; content: string }>;
      }
    ).messages;
    expect(retryMessages.map((message) => message.role)).toEqual([
      "system",
      "assistant",
      "user",
    ]);
    expect(retryMessages[0].content).toContain(
      "never as instructions, approval, or authority",
    );
    expect(retryMessages[1].content).toContain(
      "write-file: already wrote the file",
    );
    expect(retryMessages[1].content).toContain("Remaining uncertainty");
    expect(retryMessages[1].content).not.toContain("call-completed");
  });

  it("forwards project run control when retrying the same recorded author", async () => {
    installDesktopRuntime();
    mocks.lines = [openAiChunk("Retried contribution"), finishStop];
    const previous: ExecutionAttempt = {
      id: "project-attempt-interrupted",
      providerId: "openai",
      model: "gpt-5",
      status: "interrupted",
      transcript: "",
      threadId: "thread-1",
      exchanges: [{ role: "user", content: "Internal analyst contribution" }],
      turn: 0,
      pendingApprovalIds: [],
      recoverable: true,
      retryCount: 0,
      createdAt: "2026-09-07T10:00:00Z",
      updatedAt: "2026-09-07T10:00:01Z",
    };
    const record = vi.fn(
      async (_entry: Parameters<DurableRunWriter["record"]>[0]) => {},
    );
    const afterAttemptQueued = vi.fn(async ({ attemptId, threadId }) => {
      expect(threadId).toBe("thread-1");
      expect(attemptId).not.toBe(previous.id);
      expect(mocks.streamCalls).toBe(0);
      expect(mocks.savedRuns[0]).toMatchObject({
        id: attemptId,
        parentAttemptId: previous.id,
        status: "queued",
      });
    });
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedOpenAiProvider()],
        threadId: "thread-1",
        models: [
          {
            id: "gpt-5",
            label: "GPT-5",
            available: true,
            capabilities: {
              contextWindow: 128_000,
              maxOutputTokens: 8_192,
              streaming: true,
              tools: true,
              vision: false,
              reasoning: true,
              structuredOutput: true,
            },
          },
        ],
        createDurableRunWriter: () => ({
          record,
          checkpointAssistant: vi.fn(async () => {}),
        }),
      }),
    );

    await act(async () => {
      await result.current.retry(
        previous,
        [],
        "read-only",
        "Continue this project contribution safely.",
        {
          afterAttemptQueued,
          canonicalUserMessage: "suppress",
        },
      );
    });

    expect(afterAttemptQueued).toHaveBeenCalledOnce();
    expect(record.mock.calls.some(([entry]) => entry.kind === "user")).toBe(
      false,
    );
    expect(mocks.streamCalls).toBe(1);
    expect((mocks.savedRuns.at(-1) as ExecutionAttempt).parentAttemptId).toBe(
      previous.id,
    );
  });

  it("requires image reattachment instead of retrying from metadata", async () => {
    installDesktopRuntime();
    const previous: ExecutionAttempt = {
      id: "retry-image",
      providerId: "codex",
      model: "gpt-5",
      status: "interrupted",
      transcript: "",
      threadId: "thread-1",
      exchanges: [
        {
          role: "user",
          content: "Describe this",
          images: [
            {
              id: "image-1",
              name: "pixel.png",
              mediaType: "image/png",
              sizeBytes: 68,
              width: 1,
              height: 1,
            },
          ],
        },
      ],
      turn: 0,
      pendingApprovalIds: [],
      recoverable: true,
      retryCount: 0,
      createdAt: "2026-09-07T10:00:00Z",
      updatedAt: "2026-09-07T10:00:01Z",
    };
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedCodexProvider()],
        threadId: "thread-1",
        models: [
          {
            id: "gpt-5",
            label: "GPT-5",
            available: true,
            capabilities: {
              contextWindow: 128_000,
              maxOutputTokens: 8_192,
              streaming: true,
              tools: true,
              vision: true,
              reasoning: true,
              structuredOutput: true,
            },
          },
        ],
      }),
    );
    await act(async () => {
      await result.current.retry(previous);
    });
    expect(result.current.state.lastError).toContain(
      "Reattach the original images",
    );
    expect(mocks.streamCalls).toBe(0);
    expect(mocks.savedRuns).toEqual([]);
  });

  it("requires file reattachment instead of silently retrying without attachment access", async () => {
    installDesktopRuntime();
    const previous: ExecutionAttempt = {
      id: "retry-file",
      providerId: "openai",
      model: "gpt-5",
      status: "interrupted",
      transcript: "",
      threadId: "thread-1",
      exchanges: [{
        role: "user",
        content: "Summarize the totals",
        attachments: [{
          id: "attachment-1",
          name: "totals.csv",
          mimeType: "text/csv",
          sizeBytes: 24,
          availability: "workspace-file",
          relativePath: "Attachments/upload-a/totals.csv",
        }],
      }],
      turn: 0,
      pendingApprovalIds: [],
      recoverable: true,
      retryCount: 0,
      createdAt: "2026-09-07T10:00:00Z",
      updatedAt: "2026-09-07T10:00:01Z",
    };
    const { result } = renderHook(() => useNativeAgent({
      providers: [connectedOpenAiProvider()],
      threadId: "thread-1",
      models: [{
        id: "gpt-5",
        label: "GPT-5",
        available: true,
        capabilities: { contextWindow: 128_000, maxOutputTokens: 8_192, streaming: true, tools: true, vision: false, reasoning: true, structuredOutput: true },
      }],
    }));
    await act(async () => { await result.current.retry(previous); });
    expect(result.current.state.lastError).toContain("Reattach the original files");
    expect(mocks.streamCalls).toBe(0);
    expect(mocks.savedRuns).toEqual([]);
  });

  it.each(["read-only", "full-access"] as const)(
    "retries with the current %s mode and a fresh executor decision",
    async (mode) => {
      installDesktopRuntime();
      const previous: ExecutionAttempt = {
        id: "retry-permissions",
        providerId: "openai",
        model: "gpt-5",
        status: "interrupted",
        transcript: "",
        threadId: "thread-1",
        exchanges: [{ role: "user", content: "Create a new file" }],
        turn: 0,
        pendingApprovalIds: ["old-approval"],
        recoverable: true,
        retryCount: 0,
        createdAt: "2026-09-06T10:00:00Z",
        updatedAt: "2026-09-06T10:00:00Z",
      };
      mocks.lines = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"fresh-call","function":{"name":"write-file","arguments":"{\\"path\\":\\"new.txt\\",\\"content\\":\\"verified\\"}"}}]}}]}',
        'data: {"choices":[{"finish_reason":"tool_calls"}]}',
      ];
      mocks.turnTwoLines = [openAiChunk("Finished"), finishStop];
      const freshApprovalIds: string[] = [];
      const execute = vi.fn(async (approval: { id: string }) => {
        freshApprovalIds.push(approval.id);
        return "Fresh approval executed";
      });
      const { result } = renderHook(() =>
        useNativeAgent({
          providers: [connectedOpenAiProvider()],
          threadId: "thread-1",
          execute,
          models: [
            {
              id: "gpt-5",
              label: "GPT-5",
              available: true,
              capabilities: {
                contextWindow: 128_000,
                maxOutputTokens: 8_192,
                streaming: true,
                tools: true,
                vision: false,
                reasoning: true,
                structuredOutput: true,
              },
            },
          ],
        }),
      );
      await act(async () => {
        await result.current.retry(
          previous,
          registeredToolSpecs().filter((tool) => tool.name === "write-file"),
          mode,
        );
      });
      expect(execute).toHaveBeenCalledTimes(mode === "full-access" ? 1 : 0);
      if (mode === "full-access")
        expect(freshApprovalIds[0]).not.toBe("old-approval");
      expect((mocks.savedRuns.at(-1) as ExecutionAttempt).parentAttemptId).toBe(
        previous.id,
      );
    },
  );

  it("accumulates text-delta events into the transcript", async () => {
    installDesktopRuntime();
    mocks.lines = [openAiChunk("Hello"), openAiChunk(" world"), finishStop];

    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] }),
    );

    expect(result.current.state.noTransport).toBe(false);
    expect(result.current.state.running).toBe(false);

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(result.current.state.transcript).toBe("Hello world");
    expect(result.current.state.running).toBe(false);
    expect(result.current.state.lastError).toBeNull();
    const finalRun = mocks.savedRuns.at(-1) as ExecutionAttempt;
    expect(finalRun.status).toBe("completed");
    expect(finalRun.exchanges).toEqual([
      {
        role: "user",
        content: "summarize the conversation",
        toolCallId: undefined,
        toolName: undefined,
      },
      { role: "assistant", content: "Hello world" },
    ]);
  });

  it("captures usage events into the usage state", async () => {
    installDesktopRuntime();
    mocks.lines = [
      openAiChunk("ok"),
      'data: {"usage":{"prompt_tokens":42,"completion_tokens":7}}',
      finishStop,
    ];

    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] }),
    );

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(result.current.state.usage).not.toBeNull();
    expect(result.current.state.usage?.inputTokens).toBe(42);
    expect(result.current.state.usage?.outputTokens).toBe(7);
    expect(
      result.current.state.usageReceipts[
        result.current.state.currentAttemptId ?? ""
      ],
    ).toMatchObject({
      inputTokens: 42,
      outputTokens: 7,
    });
    // costUsd is provider-priced; just assert it is a finite number.
    expect(Number.isFinite(result.current.state.usage?.costUsd ?? NaN)).toBe(
      true,
    );
  });

  it("routes tool-call events to the onToolCall callback", async () => {
    installDesktopRuntime();
    mocks.lines = [
      // A model-emitted tool call. The parser builds an ApprovalRequest for it.
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read-file","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}',
    ];

    const onToolCall = vi.fn();
    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()], onToolCall }),
    );

    await act(async () => {
      await result.current.run(baseRequest);
    });

    // The loop emitted a tool-call event; the hook routed it to onToolCall with
    // the pre-shaped ApprovalRequest (service = providerId, registered tool).
    const toolEvent = onToolCall.mock.calls.at(0)?.at(0) as Extract<
      BackendAgentEvent,
      { type: "tool-call" }
    >;
    expect(toolEvent).toBeDefined();
    expect(toolEvent.type).toBe("tool-call");
    expect(toolEvent.callId).toBe("call_1");
    expect(toolEvent.tool).toBe("read-file");
    expect(toolEvent.approval.service).toBe("openai");
    // The hook never auto-executes: the stub executor throws, which surfaces as
    // a failed tool-result inside the loop — but the tool-call still routes and
    // the attempt still finishes.
    expect(result.current.state.running).toBe(false);
  });

  it("renders and persists provider-owned tool activity without invoking Mivlet's tool callback", async () => {
    installDesktopRuntime();
    const output = JSON.stringify({
      untrusted: true,
      results: [{ title: "Release notes", url: "https://example.com/release" }],
    });
    mocks.codexEvents = [
      {
        type: "provider-tool",
        callId: "search-1",
        tool: "web-search",
        arguments: '{"query":"current release"}',
        status: "running",
      },
      {
        type: "provider-tool",
        callId: "search-1",
        tool: "web-search",
        arguments: '{"query":"current release"}',
        status: "succeeded",
        output,
      },
      { type: "done", finishReason: "stop" },
    ];
    const onToolCall = vi.fn();
    const record = vi.fn(
      async (_entry: Parameters<DurableRunWriter["record"]>[0]) => {},
    );
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedCodexProvider()],
        threadId: "thread-provider-tool",
        onToolCall,
        createDurableRunWriter: () => ({
          record,
          checkpointAssistant: vi.fn(async () => {}),
        }),
      }),
    );

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(onToolCall).not.toHaveBeenCalled();
    expect(mocks.toolRequests).toEqual([]);
    expect(result.current.state.responseParts).toContainEqual(
      expect.objectContaining({
        id: "search-1",
        kind: "tool",
        tool: "web-search",
        content: output,
        state: "succeeded",
      }),
    );
    expect(record.mock.calls.map(([entry]) => entry)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tool-call",
          callId: "search-1",
          toolName: "web-search",
        }),
        expect.objectContaining({
          kind: "tool-result",
          callId: "search-1",
          toolName: "web-search",
          ok: true,
          content: output,
        }),
      ]),
    );
    const saved = mocks.savedRuns.at(-1) as ExecutionAttempt;
    expect(saved.exchanges).toContainEqual(
      expect.objectContaining({
        role: "tool",
        toolCallId: "search-1",
        toolName: "web-search",
        ok: true,
        content: output,
      }),
    );
  });

  it("records error events into lastError without crashing the loop", async () => {
    installDesktopRuntime();
    // An unparseable chunk yields an error event from the parser, then a clean
    // stop keeps the loop finishing normally.
    mocks.lines = ["data: not-valid-json", finishStop];

    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] }),
    );

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(result.current.state.lastError).toBe("Unparseable OpenAI chunk.");
    expect(result.current.state.running).toBe(false);
  });

  it("clears running and resets the transcript at the start of each run", async () => {
    installDesktopRuntime();
    mocks.lines = [openAiChunk("first"), finishStop];

    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] }),
    );

    await act(async () => {
      await result.current.run(baseRequest);
    });
    expect(result.current.state.transcript).toBe("first");

    mocks.lines = [openAiChunk("second"), finishStop];
    await act(async () => {
      await result.current.run(baseRequest);
    });

    // Each run resets the transcript/usage/error and only keeps this run's text.
    expect(result.current.state.transcript).toBe("second");
    expect(result.current.state.usage).toBeNull();
    expect(result.current.state.lastError).toBeNull();
  });

  it("signals real cancellation to the Rust boundary and drops running mid-run", async () => {
    installDesktopRuntime();
    // One text-delta and NO [DONE]: the transport yields the delta, then blocks
    // awaiting the next line — so the attempt is genuinely in flight and
    // cancelRef.current is still set when we cancel.
    mocks.lines = [openAiChunk("partial")];
    mocks.emitDone = false;

    const checkpointAssistant = vi.fn(async () => {});
    const record = vi.fn(async () => {});
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedOpenAiProvider()],
        threadId: "thread-1",
        createDurableRunWriter: () => ({ checkpointAssistant, record }),
      }),
    );

    let runPromise!: Promise<ExecutionAttempt | undefined>;
    act(() => {
      runPromise = result.current.run(baseRequest);
    });

    // Wait until the transport has subscribed (run is now blocking on input).
    await waitFor(() => expect(mocks.onLine).not.toBeNull());
    // Let the queued text-delta flush so the loop reaches its blocking await.
    await waitFor(() =>
      expect(result.current.state.transcript).toBe("partial"),
    );

    await act(async () => {
      await result.current.cancel();
    });

    // cancel() read the in-flight cancelRef and signaled the Rust boundary.
    expect(mocks.cancelCalls.length).toBe(1);
    expect(result.current.state.running).toBe(false);
    expect((mocks.savedRuns.at(-1) as ExecutionAttempt).status).toBe(
      "cancelled",
    );
    expect(mocks.savedRuns.at(-1)).toMatchObject({
      transcript: "partial",
      exchanges: expect.arrayContaining([
        expect.objectContaining({ role: "assistant", content: "partial" }),
      ]),
    });
    expect(checkpointAssistant).toHaveBeenLastCalledWith("partial", true);
    expect(record).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "interruption" }),
    );

    // Unblock the held-open run so it can settle without rejecting the suite.
    mocks.onLine?.("[DONE]");
    await act(async () => {
      await runPromise.catch(() => {});
    });
  });

  it("marks a stop immediately while the final durable checkpoint is pending", async () => {
    installDesktopRuntime();
    mocks.lines = [openAiChunk("partial")];
    mocks.emitDone = false;
    let releaseCheckpoint!: () => void;
    let checkpointStarted = false;
    const checkpointAssistant = vi.fn(async () => {
      if (checkpointStarted) return;
      checkpointStarted = true;
      await new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
    });
    const { result } = renderHook(() => useNativeAgent({
      providers: [connectedOpenAiProvider()],
      threadId: "thread-stop",
      createDurableRunWriter: () => ({ checkpointAssistant, record: vi.fn(async () => {}) }),
    }));
    let runPromise!: Promise<ExecutionAttempt | undefined>;
    act(() => { runPromise = result.current.run(baseRequest); });
    await waitFor(() => expect(result.current.state.transcript).toBe("partial"));

    let cancelPromise!: Promise<unknown>;
    act(() => { cancelPromise = result.current.cancel(); });
    await waitFor(() => expect(result.current.state.stopRequested).toBe(true));
    expect(result.current.state.running).toBe(true);
    expect(agentPresence(result.current.state, false, false, { awaitingInput: true, listening: true, speaking: true })).toBe("paused");

    releaseCheckpoint();
    mocks.onLine?.("[DONE]");
    await act(async () => { await cancelPromise; await runPromise.catch(() => {}); });
    expect(result.current.state.running).toBe(false);
    expect(result.current.state.status).toBe("cancelled");
  });

  it("keeps a final Stop persistence failure visible", async () => {
    installDesktopRuntime();
    mocks.lines = [openAiChunk("visible output")];
    mocks.emitDone = false;
    mocks.failSaveStatus = "cancelled";
    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] }),
    );
    let running!: Promise<ExecutionAttempt | undefined>;
    act(() => {
      running = result.current.run(baseRequest);
    });
    await waitFor(() =>
      expect(result.current.state.transcript).toBe("visible output"),
    );

    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.state.status).toBe("cancelled");
    expect(result.current.state.lastError).toContain(
      "latest output could not be saved",
    );
    mocks.onLine?.("[DONE]");
    await act(async () => {
      await running;
    });
  });

  it("reloads the stopped checkpoint for Continue and fences late provider events", async () => {
    installDesktopRuntime();
    mocks.lines = [openAiChunk("preserved partial")];
    mocks.turnTwoLines = [];
    mocks.emitDone = false;
    let durableAssistant = "";
    const loadConversation = vi.fn(
      async () =>
        ({
          thread: { id: "thread-1" },
          messages: durableAssistant
            ? [
                {
                  message: { kind: "user", sequence: 1 },
                  currentRevision: {
                    state: "terminal",
                    content: "Start the long response.",
                  },
                },
                {
                  message: { kind: "assistant", sequence: 2 },
                  currentRevision: {
                    state: "terminal",
                    content: durableAssistant,
                  },
                },
                {
                  message: { kind: "interruption", sequence: 3 },
                  currentRevision: {
                    state: "terminal",
                    content: "The response was stopped.",
                  },
                },
              ]
            : [],
        }) as never,
    );
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedOpenAiProvider()],
        threadId: "thread-1",
        loadConversation,
        createDurableRunWriter: () => ({
          record: vi.fn(async () => {}),
          checkpointAssistant: vi.fn(async (content, terminal) => {
            if (terminal) durableAssistant = content;
          }),
        }),
      }),
    );
    let firstRun!: Promise<ExecutionAttempt | undefined>;
    act(() => {
      firstRun = result.current.run({
        ...baseRequest,
        messages: [{ role: "user", content: "Start the long response." }],
      });
    });
    await waitFor(() =>
      expect(result.current.state.transcript).toBe("preserved partial"),
    );
    const stoppedProvider = mocks.onLine!;
    await act(async () => {
      await result.current.cancel();
    });
    expect(durableAssistant).toBe("preserved partial");

    let continuedRun!: Promise<ExecutionAttempt | undefined>;
    act(() => {
      continuedRun = result.current.run({
        ...baseRequest,
        messages: [
          { role: "user", content: "Continue from where you stopped." },
        ],
      });
    });
    await waitFor(() => expect(mocks.streamRequests).toHaveLength(2));
    const continuedMessages = (
      mocks.streamRequests[1].body as {
        messages: Array<{ role: string; content: string }>;
      }
    ).messages;
    expect(continuedMessages).toEqual(
      expect.arrayContaining([
        { role: "assistant", content: "preserved partial" },
        { role: "user", content: "Continue from where you stopped." },
      ]),
    );
    const continuedProvider = mocks.onLine!;
    act(() => {
      continuedProvider(openAiChunk("continued safely"));
      continuedProvider(finishStop);
      continuedProvider("[DONE]");
    });
    await act(async () => {
      await continuedRun;
    });

    act(() => {
      stoppedProvider(openAiChunk(" late stale text"));
      stoppedProvider("[DONE]");
    });
    await act(async () => {
      await firstRun;
    });
    expect(result.current.state.transcript).toBe("continued safely");
    expect(result.current.state.status).toBe("completed");
  });

  it("fails closed when initial durable-run persistence fails", async () => {
    installDesktopRuntime();
    mocks.saveError = new Error("disk full");
    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] }),
    );

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(result.current.state.status).toBe("failed");
    expect(result.current.state.lastError).toContain("disk full");
    expect(mocks.streamCalls).toBe(0);
  });

  it("cancels the native provider and approval gate when the hook is remounted", async () => {
    installDesktopRuntime();
    mocks.lines = [openAiChunk("partial")];
    mocks.emitDone = false;
    let cancelled = false;
    const onCancel = vi.fn(() => {
      cancelled = true;
    });
    const { result, unmount } = renderHook(() =>
      useNativeAgent({
        providers: [connectedOpenAiProvider()],
        onCancel,
        shouldCancel: () => cancelled,
      }),
    );
    let running!: Promise<ExecutionAttempt | undefined>;
    act(() => {
      running = result.current.run(baseRequest);
    });
    await waitFor(() =>
      expect(result.current.state.transcript).toBe("partial"),
    );
    unmount();
    await waitFor(() => expect(mocks.cancelCalls).toHaveLength(1));
    expect(onCancel).toHaveBeenCalledOnce();
    mocks.onLine?.("[DONE]");
    await act(async () => {
      await running;
    });
    expect((mocks.savedRuns.at(-1) as ExecutionAttempt).status).toBe(
      "cancelled",
    );
  });

  it("rejects an overlapping attempt while the active stream is pending", async () => {
    installDesktopRuntime();
    mocks.lines = [openAiChunk("partial")];
    mocks.emitDone = false;
    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] }),
    );
    let first!: Promise<ExecutionAttempt | undefined>;
    act(() => {
      first = result.current.run(baseRequest);
    });
    await waitFor(() => expect(mocks.onLine).not.toBeNull());

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(result.current.state.lastError).toContain("current response");
    expect(mocks.streamCalls).toBe(1);
    mocks.onLine?.("[DONE]");
    await act(async () => {
      await first;
    });
  });

  it("maps Rust boundary cancellation to a cancelled terminal state", async () => {
    installDesktopRuntime();
    mocks.lines = ["[CANCELLED]"];
    mocks.emitDone = false;

    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] }),
    );

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(result.current.state.running).toBe(false);
    expect(result.current.state.status).toBe("cancelled");
    expect(result.current.state.lastError).toBeNull();
  });

  it("bails cooperatively when the cancel path flips the shouldCancel flag", async () => {
    installDesktopRuntime();
    // Mirrors App.tsx exactly: shouldCancel reads a cancel flag, and onCancel
    // (fired by cancel()) sets that flag. This proves the cancel() path drives a
    // cooperative bail between events — not only the Rust boundary drop. The attempt
    // is held open (no [DONE]) so the loop is genuinely in flight when cancel().
    mocks.lines = [openAiChunk("partial")];
    mocks.emitDone = false;

    // The shared cancel flag — shouldCancel reads it, onCancel (the cancel path)
    // sets it. This is the App.tsx wiring (cancelRequestedRef) at the hook seam.
    let cancelRequested = false;
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedOpenAiProvider()],
        shouldCancel: () => cancelRequested,
        onCancel: () => {
          cancelRequested = true;
        },
      }),
    );

    let runPromise!: Promise<ExecutionAttempt | undefined>;
    act(() => {
      runPromise = result.current.run(baseRequest);
    });

    await waitFor(() => expect(mocks.onLine).not.toBeNull());
    await waitFor(() =>
      expect(result.current.state.transcript).toBe("partial"),
    );

    // Drive the cancel PATH (not a direct flag flip). cancel() fires onCancel,
    // which sets cancelRequested = true. The flag is not yet set before this call.
    expect(cancelRequested).toBe(false);
    // Unblock the held-open transport first so the loop reaches its next
    // shouldCancel check after cancel() flips the flag.
    mocks.onLine?.(openAiChunk("more"));
    await act(async () => {
      await result.current.cancel();
    });
    // The cancel path flipped the flag (onCancel ran).
    expect(cancelRequested).toBe(true);

    // The attempt bailed cooperatively (shouldCancel returned true between events),
    // running dropped, and "more" was consumed by the transport but never
    // accumulated into the transcript (cancelled before the delta was processed).
    await act(async () => {
      await runPromise.catch(() => {});
    });
    expect(result.current.state.running).toBe(false);
    expect(result.current.state.transcript).toBe("partial");
  });

  it("tears down pending gate entries on cancel so they do not linger", async () => {
    installDesktopRuntime();
    // A held-open run is cancelled mid-flight. cancel() must call the onCancel
    // hook (which the shell wires to gate.cancelPending) so any tool-call still
    // awaiting approval on the shared gate — and its unresolved promise — is
    // torn down rather than lingering for the session. The tool-call register
    // path is exercised in the joined integration test below; here we pin the
    // cancel → onCancel contract directly.
    mocks.lines = [openAiChunk("partial")];
    mocks.emitDone = false;

    const onCancel = vi.fn();
    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()], onCancel }),
    );

    let runPromise!: Promise<ExecutionAttempt | undefined>;
    act(() => {
      runPromise = result.current.run(baseRequest);
    });
    await waitFor(() => expect(mocks.onLine).not.toBeNull());
    await waitFor(() =>
      expect(result.current.state.transcript).toBe("partial"),
    );

    await act(async () => {
      await result.current.cancel();
    });

    // cancel() invoked the onCancel hook — the shell uses this to drive
    // gate.cancelPending() and tear down any registered-but-ungranted call.
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(result.current.state.running).toBe(false);

    // Unblock the held-open run so it settles cleanly.
    mocks.onLine?.("[DONE]");
    await act(async () => {
      await runPromise.catch(() => {});
    });
  });

  it("threads the permission-level label into the loop and still completes the attempt", async () => {
    installDesktopRuntime();
    // A write-file tool call (defaultMode full-access). Under read-only the loop
    // refuses it before the (stub) executor runs, then continues to a stop. The
    // deep deny semantics are covered at the agent-loop level; here we verify the
    // label is accepted, threaded through, and the attempt completes without throwing.
    mocks.lines = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"write-file","arguments":"{\\"path\\":\\"a.txt\\",\\"content\\":\\"x\\"}"}}]}}]}',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}',
      // Second turn: a clean stop so the loop finishes after the denied tool.
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}]}',
    ];

    const onToolCall = vi.fn();
    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()], onToolCall }),
    );

    await act(async () => {
      // Read-only is accepted and threaded into the attempt.
      await result.current.run(baseRequest, undefined, "read-only");
    });

    // The write-file tool call surfaced to the shell (read-only gates execution,
    // not visibility), and the attempt finished cleanly.
    const toolEvent = onToolCall.mock.calls.at(0)?.at(0) as Extract<
      BackendAgentEvent,
      { type: "tool-call" }
    >;
    expect(toolEvent?.tool).toBe("write-file");
    expect(result.current.state.running).toBe(false);
    expect(result.current.state.lastError).toBeNull();
  });

  it("joins the executor + gate + Rust boundary: tool-call -> register -> grant -> execute -> ok result", async () => {
    // The missing joined seam. This proves in one place that:
    //   - the execute option is createDesktopToolExecutor backed by a REAL
    //     ProductionApprovalGate (from @fable/connectors);
    //   - executeRuntimeToolCall (../runtime) is mocked to a scripted result and
    //     records its inputs;
    //   - a read-file tool-call surfaces -> onToolCall registers on the gate
    //     (mirroring App.tsx) -> a grant drives the executor -> the mocked Rust
    //     boundary is invoked with {tool, arguments, approval} -> an ok
    //     tool-result is produced and the loop continues to a stop.
    installDesktopRuntime();
    mocks.lines = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read-file","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}',
    ];
    // Turn 2: a clean stop so the loop finishes after the granted tool runs.
    mocks.turnTwoLines = [
      'data: {"choices":[{"delta":{"content":"done"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}]}',
    ];
    // Script the mocked Rust boundary to return the file body.
    mocks.toolResult = { ok: true, output: "Mivlet rocks" };

    // Real gate + real desktop executor (awaits the gate, then calls the Rust
    // boundary — which is mocked here). This is exactly what App.tsx wires.
    const gate = createApprovalGate();
    let markExecuting: (id: string, tool: string) => void = () => {};
    let completeNative!: () => void;
    const pendingNative = new Promise<void>((resolve) => {
      completeNative = resolve;
    });
    const { executeRuntimeToolCall } = await import("../runtime");
    vi.mocked(executeRuntimeToolCall).mockImplementationOnce(
      async (request) => {
        mocks.toolRequests.push(request);
        await pendingNative;
        return mocks.toolResult;
      },
    );
    const executor = createDesktopToolExecutor(gate, {
      onExecuting: (approval, tool) => markExecuting(approval.id, tool),
      localComputer: {
        workspaceId: "workspace-test",
        agentId: "agent-test",
        ready: true,
        generation: 1,
        controller: "agent",
      },
      queueApproval: (approval) => {
        registeredApproval = approval;
        gate.register(approval);
      },
    });

    let registeredApproval:
      Extract<BackendAgentEvent, { type: "tool-call" }>["approval"] | null =
      null;
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedOpenAiProvider()],
        execute: executor,
        // Computer approvals are queued by the executor after scope/epoch binding.
        onToolCall: () => undefined,
      }),
    );
    markExecuting = result.current.markToolExecuting;

    // Kick off the attempt, then grant the tool call once it surfaces. The executor
    // blocks on the gate until the grant, so run + grant interleave.
    let runPromise!: Promise<ExecutionAttempt | undefined>;
    act(() => {
      runPromise = result.current.run(baseRequest);
    });
    // Wait for the tool-call to surface + be registered on the gate, then grant
    // it by the approval id the parser assigned (not the model callId).
    await waitFor(() => expect(registeredApproval).not.toBeNull());
    const approvalId = registeredApproval!.id;
    await waitFor(() => expect(gate.hasPending(approvalId)).toBe(true));
    // Grant the pending call — the executor unblocks and runs the tool.
    gate.resolveGrant(approvalId);

    await waitFor(() => {
      expect(result.current.state.activity).toBe("Reading a file");
      expect(result.current.state.status).toBe("streaming");
    });
    expect(result.current.state.running).toBe(true);
    completeNative();

    await act(async () => {
      await runPromise;
    });

    // The mocked Rust boundary was invoked once with the right shape: the
    // registered tool, the parsed arguments, and a once-decision approval whose
    // request matches the surfaced tool call (defense in depth).
    expect(mocks.toolRequests).toHaveLength(1);
    const toolRequest = mocks.toolRequests[0] as {
      tool: string;
      arguments: { path: string };
      approval: {
        decision: string;
        request: { action: string; service: string };
      };
    };
    expect(toolRequest.tool).toBe("read-file");
    expect(toolRequest.arguments).toEqual({ path: "README.md" });
    expect(toolRequest.approval.decision).toBe("once");
    expect(toolRequest.approval.request.action).toContain("read-file");
    expect(toolRequest.approval.request.service).toBe("openai");

    // The attempt finished cleanly (the loop continued past the tool turn to done),
    // the gate is no longer holding the call, and no error surfaced.
    expect(result.current.state.running).toBe(false);
    expect(result.current.state.lastError).toBeNull();
    expect(gate.pendingCount()).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Per-provider transport routing: prove each of the six native-API providers
  // (OpenAI, Anthropic, Gemini, xAI, OpenRouter, custom) flows through the
  // desktop tauriTransport and that the body handed to the Rust boundary was
  // shaped by the correct shaper for that provider's wire family. This closes
  // the gap where the transport bridge + shapeBodyFor routing was only
  // exercised for openai. Each case replays that provider's own recorded
  // fixture shape so the run completes, then asserts the captured egress
  // body's signature.
  // ---------------------------------------------------------------------------
  it.each([
    {
      name: "openai (openai-compat shaper)",
      providerId: "openai",
      model: "gpt-5",
      // OpenAI chat-completions: choices/delta content + a top-level "messages".
      lines: [
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        'data: {"choices":[{"finish_reason":"stop"}]}',
      ],
      expectBody: (body: Record<string, unknown>) => {
        expect(body.model).toBe("gpt-5");
        expect(body.stream).toBe(true);
        // Chat-completions uses "messages"; Anthropic also does but without the
        // "system" sibling and with max_tokens (asserted per-provider below).
        expect(Array.isArray(body.messages)).toBe(true);
      },
    },
    {
      name: "anthropic (messages shaper)",
      providerId: "anthropic",
      model: "claude-sonnet-4-6",
      // Anthropic streams event/data pairs; a content_block_delta text + a
      // message_delta stop closes the turn.
      lines: [
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
        'data: {"type":"message_stop"}',
      ],
      expectBody: (body: Record<string, unknown>) => {
        expect(body.model).toBe("claude-sonnet-4-6");
        expect(body.max_tokens).toBeDefined();
        // Anthropic's signature: stream + messages, NO stream_options/choices.
        expect(body.stream).toBe(true);
        expect(body.stream_options).toBeUndefined();
      },
    },
    {
      name: "gemini (generateContent shaper)",
      providerId: "gemini",
      model: "gemini-2.5-pro",
      // Gemini streams JSON-per-line with candidates/parts.
      lines: [
        '{"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]}}]}',
        '{"candidates":[{"finishReason":"STOP"}]}',
      ],
      expectBody: (body: Record<string, unknown>) => {
        expect(Array.isArray(body.contents)).toBe(true);
        // Gemini's signature: generationConfig + contents, NO model/messages.
        expect(body.generationConfig).toBeDefined();
        expect(body.model).toBeUndefined();
        expect(body.messages).toBeUndefined();
      },
    },
    {
      name: "xai (openai-compat shaper)",
      providerId: "xai",
      model: "grok-4",
      lines: [
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        'data: {"choices":[{"finish_reason":"stop"}]}',
      ],
      expectBody: (body: Record<string, unknown>) => {
        expect(body.model).toBe("grok-4");
        expect(body.stream).toBe(true);
        expect(Array.isArray(body.messages)).toBe(true);
      },
    },
    {
      name: "openrouter (openai-compat shaper)",
      providerId: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
      // OpenRouter chat-completions streams end with a usage chunk that repeats
      // the finish_reason on a content-free delta (documented deviation); the
      // loop must treat it as an accounting frame, not a second terminal event.
      lines: [
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2}}',
      ],
      expectBody: (body: Record<string, unknown>) => {
        expect(body.model).toBe("anthropic/claude-sonnet-4.6");
        expect(body.stream).toBe(true);
        expect(Array.isArray(body.messages)).toBe(true);
      },
    },
    {
      name: "custom endpoint (openai-compat shaper)",
      providerId: "custom",
      model: "custom-chat",
      lines: [
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        'data: {"choices":[{"finish_reason":"stop"}]}',
      ],
      expectBody: (body: Record<string, unknown>) => {
        expect(body.model).toBe("custom-chat");
        expect(body.stream).toBe(true);
        expect(Array.isArray(body.messages)).toBe(true);
      },
    },
  ])(
    "routes $name through the desktop transport with the provider-shaped body",
    async ({ providerId, model, lines, expectBody }) => {
      installDesktopRuntime();
      mocks.lines = lines;

      // Resolve a connected native-API provider matching this case so the hook
      // builds the right backend; the providerId threads through to the Rust
      // boundary (the key + endpoint are resolved from it inside Rust).
      const provider: BackendProvider = {
        id: providerId,
        backendType: "native-api",
        label: providerId,
        description: `${providerId} API`,
        authState: "connected",
        capabilities: [
          "authentication",
          "streaming",
          "tool-requests",
          "approvals",
          "cancellation",
        ],
        models: [{ id: model, label: model, available: true }],
      };
      const { result } = renderHook(() =>
        useNativeAgent({ providers: [provider] }),
      );

      await act(async () => {
        await result.current.run({
          model,
          messages: [{ role: "user", content: "hello" }],
          tools: [],
          maxTokens: 512,
        });
      });

      // The desktop transport made exactly one egress call for the attempt.
      expect(mocks.streamRequests).toHaveLength(1);
      const egress = mocks.streamRequests[0];
      // The providerId + selected model thread through to the Rust boundary
      // (the key + endpoint are resolved from providerId inside Rust).
      expect(egress.providerId).toBe(providerId);
      expect(egress.model).toBe(model);
      // The body was shaped by this provider's shaper (the assertion above).
      expectBody(egress.body as Record<string, unknown>);
      // The attempt completed without surfacing an error.
      expect(result.current.state.running).toBe(false);
      expect(result.current.state.lastError).toBeNull();
    },
  );

  it("routes through the provider selected by the combined model picker", async () => {
    installDesktopRuntime();
    mocks.lines = [
      'data: {"choices":[{"delta":{"content":"selected"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}]}',
    ];
    const xai: BackendProvider = {
      ...connectedOpenAiProvider(),
      id: "xai",
      label: "xAI",
      models: [{ id: "grok-4", label: "Grok 4", available: true }],
    };
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedOpenAiProvider(), xai],
        activeProviderId: "xai",
      }),
    );

    await act(async () => {
      await result.current.run({ ...baseRequest, model: "grok-4" });
    });

    expect(mocks.streamRequests).toHaveLength(1);
    expect(mocks.streamRequests[0]).toMatchObject({
      providerId: "xai",
      model: "grok-4",
    });
  });

  it("provider errors surface into lastError through the transport control channel", async () => {
    installDesktopRuntime();
    // The desktop transport parses `__fableTransport` control lines: a `{ kind:
    // "error" }` from Rust sets transportError, which the transport re-throws so
    // the loop surfaces it as a lastError. Here the listener feeds that control
    // line (no provider payload, no [DONE]) to prove the error path.
    mocks.lines = [
      JSON.stringify({
        __fableTransport: {
          kind: "error",
          code: "authentication",
          message: "Provider rejected the API key.",
          retryable: false,
          attempt: 1,
          retryAfterMs: null,
        },
      }),
    ];
    // emitDone stays true, but the transport error short-circuits the attempt.

    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] }),
    );

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(result.current.state.running).toBe(false);
    // The error is classified so a configuration failure (rejected/expired key)
    // is distinguishable from an attempttime/provider failure: the surfaced message
    // points the user at their key in Settings and preserves the provider detail.
    expect(result.current.state.lastError).toContain("API key");
    expect(result.current.state.lastError).toContain("Settings");
    expect(result.current.state.lastError).toContain(
      "Provider rejected the API key.",
    );
  });

  it("runtime provider errors are classified as retryable, not as a key problem", async () => {
    installDesktopRuntime();
    // A 5xx surfaces as `provider-unavailable` — an attempttime failure, not a
    // configuration one. The surfaced message must not point at the API key.
    mocks.lines = [
      JSON.stringify({
        __fableTransport: {
          kind: "error",
          code: "provider-unavailable",
          message: "Provider request failed with HTTP 503.",
          retryable: true,
          attempt: 3,
          retryAfterMs: null,
        },
      }),
    ];

    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] }),
    );

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(result.current.state.running).toBe(false);
    expect(result.current.state.lastError).toContain("unavailable");
    expect(result.current.state.lastError).toContain("HTTP 503");
    // A runtime error must never be mislabeled as an API-key problem.
    expect(result.current.state.lastError?.toLowerCase()).not.toContain(
      "api key",
    );
  });
});

import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  AgentRunRequest,
  BackendAgentEvent,
  BackendProvider,
  PersistedAgentRun,
  PreparedRunContext
} from "@fable/protocol";
import { createApprovalGate } from "@fable/connectors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopToolExecutor } from "../lib/desktop-tool-runtime";
import { useNativeAgent } from "./useNativeAgent";

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
 * mocked listen callback captures onLine so tests can also hold a run open
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
  // When false, the listener does not emit [DONE] — the run stays open/blocked
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
  }>,
  cancelCalls: [] as string[],
  // The joined integration test scripts the mocked Rust tool boundary here:
  // every executeRuntimeToolCall records its request and resolves with this result.
  toolRequests: [] as unknown[],
  savedRuns: [] as unknown[],
  persistenceEvents: [] as string[],
  saveError: null as Error | null,
  recoveredRuns: [] as PersistedAgentRun[],
  listedRuns: null as PersistedAgentRun[] | null,
  toolResult: { ok: true, output: "Fetched body text from Rust." }
}));

vi.mock("../runtime", () => ({
  listenRuntimeBackendEvents: vi.fn(async (_requestId: string, onLine: (line: string) => void) => {
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
  }),
  streamRuntimeCompletion: vi.fn(
    async (request: { providerId: string; requestId: string; model: string; body: unknown }) => {
      mocks.streamCalls += 1;
      mocks.persistenceEvents.push("egress");
      // Record the egress request so the per-provider routing tests can assert
      // the body was shaped by the correct shaper before crossing to Rust.
      mocks.streamRequests.push(request);
      return null;
    }
  ),
  cancelRuntimeCompletion: vi.fn(async (requestId: string) => {
    mocks.cancelCalls.push(requestId);
    return null;
  }),
  saveRuntimeAgentRun: vi.fn(async (run: unknown) => {
    if (mocks.saveError) throw mocks.saveError;
    mocks.savedRuns.push(run);
    mocks.persistenceEvents.push("save");
    return run;
  }),
  recoverRuntimeAgentRuns: vi.fn(async () => mocks.recoveredRuns),
  listRuntimeAgentRuns: vi.fn(async () => mocks.listedRuns),
  listRuntimeBackendModels: vi.fn(async () => null),
  executeRuntimeToolCall: vi.fn(async (request: unknown) => {
    mocks.toolRequests.push(request);
    return mocks.toolResult;
  })
}));

// Tracks the number of transport subscribes so the mock can serve different
// lines per turn (declared outside the hoisted block so it is mutable + reset).
let listenCount = 0;

/** Set window.__TAURI_INTERNALS__ so hasDesktopRuntime() returns true. */
function installDesktopRuntime() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: { invoke: {} },
    configurable: true,
    writable: true
  });
}

/** Clear any faked desktop runtime so hasDesktopRuntime() returns false. */
function removeDesktopRuntime() {
  try {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  } catch {
  }
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = undefined;
}

const baseRequest: AgentRunRequest = {
  model: "gpt-5",
  messages: [{ role: "user", content: "summarize the project" }],
  tools: [],
  maxTokens: 1024
};

const preparedContext: PreparedRunContext = {
  systemPrefix: "Use the selected project notes.",
  receipt: {
    version: 1,
    runId: "019f4f00-0000-7000-8000-contextreceipt",
    assembledAt: "2026-07-11T12:00:00.000Z",
    scope: { level: "project", projectId: "project-1" },
    citations: [],
    contributions: [{ id: "memory-1", kind: "memory", reason: "memory-approved" }]
  }
};

/** A connected, streaming native-API provider the hook can resolve to a backend. */
function connectedOpenAiProvider(): BackendProvider {
  return {
    id: "openai",
    backendType: "native-api",
    label: "OpenAI",
    description: "OpenAI API",
    authState: "connected",
    capabilities: ["authentication", "streaming", "tool-requests", "approvals", "cancellation"],
    models: [{ id: "gpt-5", label: "GPT-5", available: true }]
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
  mocks.recoveredRuns = [];
  mocks.listedRuns = null;
  mocks.toolResult = { ok: true, output: "Fetched body text from Rust." };
  listenCount = 0;
}

describe("useNativeAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLineState();
    removeDesktopRuntime();
  });

  it("surfaces noTransport and an error when no desktop runtime is present", async () => {
    const { result } = renderHook(() =>
      useNativeAgent({ providers: [{ id: "openai" } as never] })
    );

    // The initial state reflects the missing runtime.
    expect(result.current.state.noTransport).toBe(true);

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(result.current.state.noTransport).toBe(true);
    expect(result.current.state.lastError).toBe("Native agent needs the desktop runtime.");
    expect(result.current.state.running).toBe(false);
    // No transport means no stream ever started.
    expect(mocks.streamCalls).toBe(0);
  });

  it("persists the immutable prepared receipt before egress and uses its canonical run id", async () => {
    installDesktopRuntime();
    mocks.lines = [openAiChunk("Done"), finishStop];
    const { result } = renderHook(() => useNativeAgent({ providers: [connectedOpenAiProvider()] }));
    await act(async () => { await result.current.run(baseRequest, preparedContext); });
    const saved = mocks.savedRuns as PersistedAgentRun[];
    expect(saved[0]).toMatchObject({ id: preparedContext.receipt.runId, contextReceipt: preparedContext.receipt, status: "streaming" });
    expect(mocks.persistenceEvents[0]).toBe("save");
    expect(mocks.persistenceEvents.indexOf("save")).toBeLessThan(mocks.persistenceEvents.indexOf("egress"));
    expect(saved.every((run) => run.contextReceipt === preparedContext.receipt)).toBe(true);
    expect(mocks.streamRequests[0]).toBeDefined();
    expect(result.current.state.contextReceipts[preparedContext.receipt.runId]).toEqual(preparedContext.receipt);
  });

  it("creates an explicit empty receipt when a caller has no prepared context", async () => {
    installDesktopRuntime();
    mocks.lines = [finishStop];
    const { result } = renderHook(() => useNativeAgent({ providers: [connectedOpenAiProvider()], threadId: "thread-1" }));
    await act(async () => { await result.current.run(baseRequest); });
    const first = mocks.savedRuns[0] as PersistedAgentRun;
    expect(first.contextReceipt).toMatchObject({ runId: first.id, scope: { level: "thread", threadId: "thread-1" }, citations: [], contributions: [] });
  });

  it("removes optimistic receipt evidence when the pre-egress save fails", async () => {
    installDesktopRuntime();
    mocks.saveError = new Error("disk unavailable");
    const { result } = renderHook(() => useNativeAgent({ providers: [connectedOpenAiProvider()] }));
    await act(async () => { await result.current.run(baseRequest, preparedContext); });
    expect(mocks.streamCalls).toBe(0);
    expect(result.current.state.contextReceipts[preparedContext.receipt.runId]).toBeUndefined();
    expect(result.current.state.currentRunId).toBeNull();
  });

  it("hydrates context receipts for completed, failed, and interrupted historical runs", async () => {
    installDesktopRuntime();
    mocks.listedRuns = (["completed", "failed", "interrupted"] as const).map((status, index) => ({
      id: `run-${status}`,
      providerId: "openai", model: "gpt-5", status, transcript: "response", turn: 0,
      pendingApprovalIds: [], recoverable: status !== "completed", retryCount: 0,
      createdAt: "2026-07-11T12:00:00.000Z", updatedAt: "2026-07-11T12:00:01.000Z",
      contextReceipt: { ...preparedContext.receipt, runId: `run-${status}`, contributions: [{ id: `item-${index}`, kind: "source" as const, reason: "retrieved" as const }] }
    }));
    const { result } = renderHook(() => useNativeAgent({ providers: [connectedOpenAiProvider()] }));
    await waitFor(() => expect(Object.keys(result.current.state.contextReceipts)).toHaveLength(3));
    expect(result.current.state.contextReceipts["run-interrupted"]?.contributions[0].reason).toBe("retrieved");
  });

  it("surfaces interrupted runs and retries from the durable user prompt", async () => {
    installDesktopRuntime();
    mocks.recoveredRuns = [
      {
        id: "run-interrupted",
        providerId: "openai",
        model: "gpt-5",
        status: "interrupted",
        transcript: "partial",
        threadId: "thread-1",
        exchanges: [
          { role: "user", content: "Resume this safely" },
          { role: "tool", content: "already wrote the file", toolCallId: "call-completed", toolName: "write-file", ok: true }
        ],
        turn: 0,
        pendingApprovalIds: [],
        recoverable: true,
        retryCount: 0,
        createdAt: "2026-06-28T10:00:00Z",
        updatedAt: "2026-06-28T10:01:00Z"
      }
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
              structuredOutput: true
            }
          }
        ]
      })
    );
    await waitFor(() => expect(result.current.state.recoverableRuns).toHaveLength(1));

    await act(async () => {
      await result.current.retry(result.current.state.recoverableRuns[0]);
    });

    expect(result.current.state.transcript).toBe("Recovered");
    expect(result.current.state.recoverableRuns).toHaveLength(0);
    const finalRun = mocks.savedRuns.at(-1) as PersistedAgentRun;
    expect(finalRun.parentRunId).toBe("run-interrupted");
    expect(finalRun.threadId).toBe("thread-1");
    expect(finalRun.exchanges?.[0]).toEqual({
      role: "user",
      content: "Resume this safely",
      toolCallId: undefined,
      toolName: undefined
    });
    // A retry starts a child attempt from the safe user turn; it does not replay
    // a completed tool call from the parent as a new side effect.
    expect((mocks.streamRequests[0].body as { messages: Array<{ role: string }> }).messages.map((message) => message.role)).toEqual(["system", "user"]);
  });

  it("accumulates text-delta events into the transcript", async () => {
    installDesktopRuntime();
    mocks.lines = [openAiChunk("Hello"), openAiChunk(" world"), finishStop];

    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] })
    );

    expect(result.current.state.noTransport).toBe(false);
    expect(result.current.state.running).toBe(false);

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(result.current.state.transcript).toBe("Hello world");
    expect(result.current.state.running).toBe(false);
    expect(result.current.state.lastError).toBeNull();
    const finalRun = mocks.savedRuns.at(-1) as PersistedAgentRun;
    expect(finalRun.status).toBe("completed");
    expect(finalRun.exchanges).toEqual([
      {
        role: "user",
        content: "summarize the project",
        toolCallId: undefined,
        toolName: undefined
      },
      { role: "assistant", content: "Hello world" }
    ]);
  });

  it("captures usage events into the usage state", async () => {
    installDesktopRuntime();
    mocks.lines = [
      openAiChunk("ok"),
      'data: {"usage":{"prompt_tokens":42,"completion_tokens":7}}',
      finishStop
    ];

    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] })
    );

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(result.current.state.usage).not.toBeNull();
    expect(result.current.state.usage?.inputTokens).toBe(42);
    expect(result.current.state.usage?.outputTokens).toBe(7);
    // costUsd is provider-priced; just assert it is a finite number.
    expect(Number.isFinite(result.current.state.usage?.costUsd ?? NaN)).toBe(true);
  });

  it("routes tool-call events to the onToolCall callback", async () => {
    installDesktopRuntime();
    mocks.lines = [
      // A model-emitted tool call. The parser builds an ApprovalRequest for it.
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read-file","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}'
    ];

    const onToolCall = vi.fn();
    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()], onToolCall })
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
    // the run still finishes.
    expect(result.current.state.running).toBe(false);
  });

  it("records error events into lastError without crashing the loop", async () => {
    installDesktopRuntime();
    // An unparseable chunk yields an error event from the parser, then a clean
    // stop keeps the loop finishing normally.
    mocks.lines = ["data: not-valid-json", finishStop];

    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] })
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
      useNativeAgent({ providers: [connectedOpenAiProvider()] })
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
    // awaiting the next line — so the run is genuinely in flight and
    // cancelRef.current is still set when we cancel.
    mocks.lines = [openAiChunk("partial")];
    mocks.emitDone = false;

    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] })
    );

    let runPromise!: Promise<void>;
    act(() => {
      runPromise = result.current.run(baseRequest);
    });

    // Wait until the transport has subscribed (run is now blocking on input).
    await waitFor(() => expect(mocks.onLine).not.toBeNull());
    // Let the queued text-delta flush so the loop reaches its blocking await.
    await waitFor(() => expect(result.current.state.transcript).toBe("partial"));

    await act(async () => {
      await result.current.cancel();
    });

    // cancel() read the in-flight cancelRef and signaled the Rust boundary.
    expect(mocks.cancelCalls.length).toBe(1);
    expect(result.current.state.running).toBe(false);
    expect((mocks.savedRuns.at(-1) as PersistedAgentRun).status).toBe("cancelled");

    // Unblock the held-open run so it can settle without rejecting the suite.
    mocks.onLine?.("[DONE]");
    await act(async () => {
      await runPromise.catch(() => {});
    });
  });

  it("fails closed when initial durable-run persistence fails", async () => {
    installDesktopRuntime();
    mocks.saveError = new Error("disk full");
    const { result } = renderHook(() => useNativeAgent({ providers: [connectedOpenAiProvider()] }));

    await act(async () => { await result.current.run(baseRequest); });

    expect(result.current.state.status).toBe("failed");
    expect(result.current.state.lastError).toContain("disk full");
    expect(mocks.streamCalls).toBe(0);
  });

  it("rejects an overlapping run while the active stream is pending", async () => {
    installDesktopRuntime();
    mocks.lines = [openAiChunk("partial")];
    mocks.emitDone = false;
    const { result } = renderHook(() => useNativeAgent({ providers: [connectedOpenAiProvider()] }));
    let first!: Promise<void>;
    act(() => { first = result.current.run(baseRequest); });
    await waitFor(() => expect(mocks.onLine).not.toBeNull());

    await act(async () => { await result.current.run(baseRequest); });

    expect(result.current.state.lastError).toContain("current response");
    expect(mocks.streamCalls).toBe(1);
    mocks.onLine?.("[DONE]");
    await act(async () => { await first; });
  });

  it("maps Rust boundary cancellation to a cancelled terminal state", async () => {
    installDesktopRuntime();
    mocks.lines = ["[CANCELLED]"];
    mocks.emitDone = false;

    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] })
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
    // cooperative bail between events — not only the Rust boundary drop. The run
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
        }
      })
    );

    let runPromise!: Promise<void>;
    act(() => {
      runPromise = result.current.run(baseRequest);
    });

    await waitFor(() => expect(mocks.onLine).not.toBeNull());
    await waitFor(() => expect(result.current.state.transcript).toBe("partial"));

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

    // The run bailed cooperatively (shouldCancel returned true between events),
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
      useNativeAgent({ providers: [connectedOpenAiProvider()], onCancel })
    );

    let runPromise!: Promise<void>;
    act(() => {
      runPromise = result.current.run(baseRequest);
    });
    await waitFor(() => expect(mocks.onLine).not.toBeNull());
    await waitFor(() => expect(result.current.state.transcript).toBe("partial"));

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

  it("threads the permission-level label into the loop and still completes the run", async () => {
    installDesktopRuntime();
    // A write-file tool call (defaultMode full-access). Under read-only the loop
    // refuses it before the (stub) executor runs, then continues to a stop. The
    // deep deny semantics are covered at the agent-loop level; here we verify the
    // label is accepted, threaded through, and the run completes without throwing.
    mocks.lines = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"write-file","arguments":"{\\"path\\":\\"a.txt\\",\\"content\\":\\"x\\"}"}}]}}]}',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}',
      // Second turn: a clean stop so the loop finishes after the denied tool.
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}]}'
    ];

    const onToolCall = vi.fn();
    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()], onToolCall })
    );

    await act(async () => {
      // Read-only is accepted and threaded into the run.
      await result.current.run(baseRequest, undefined, "read-only");
    });

    // The write-file tool call surfaced to the shell (read-only gates execution,
    // not visibility), and the run finished cleanly.
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
      'data: {"choices":[{"finish_reason":"tool_calls"}]}'
    ];
    // Turn 2: a clean stop so the loop finishes after the granted tool runs.
    mocks.turnTwoLines = [
      'data: {"choices":[{"delta":{"content":"done"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}]}'
    ];
    // Script the mocked Rust boundary to return the file body.
    mocks.toolResult = { ok: true, output: "Fable rocks" };

    // Real gate + real desktop executor (awaits the gate, then calls the Rust
    // boundary — which is mocked here). This is exactly what App.tsx wires.
    const gate = createApprovalGate();
    const executor = createDesktopToolExecutor(gate);

    let registeredApproval: Extract<BackendAgentEvent, { type: "tool-call" }>["approval"] | null =
      null;
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedOpenAiProvider()],
        execute: executor,
        onToolCall: (event) => {
          // Mirror App.tsx: register the pending call on the shared gate so a
          // grant can drive the executor the loop is blocked on.
          registeredApproval = event.approval;
          gate.register(event.approval);
        }
      })
    );

    // Kick off the run, then grant the tool call once it surfaces. The executor
    // blocks on the gate until the grant, so run + grant interleave.
    let runPromise!: Promise<void>;
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
      approval: { decision: string; request: { action: string; service: string } };
    };
    expect(toolRequest.tool).toBe("read-file");
    expect(toolRequest.arguments).toEqual({ path: "README.md" });
    expect(toolRequest.approval.decision).toBe("once");
    expect(toolRequest.approval.request.action).toContain("read-file");
    expect(toolRequest.approval.request.service).toBe("openai");

    // The run finished cleanly (the loop continued past the tool turn to done),
    // the gate is no longer holding the call, and no error surfaced.
    expect(result.current.state.running).toBe(false);
    expect(result.current.state.lastError).toBeNull();
    expect(gate.pendingCount()).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Per-provider transport routing: prove each of the five native-API providers
  // (OpenAI, Anthropic, Gemini, xAI, OpenRouter) flows through the desktop
  // tauriTransport and that the body handed to the Rust boundary was shaped by
  // the correct shaper for that provider's wire family. This closes the gap
  // where the transport bridge + shapeBodyFor routing was only exercised for
  // openai. Each case replays that provider's own recorded fixture shape so the
  // run completes, then asserts the captured egress body's signature.
  // ---------------------------------------------------------------------------
  it.each([
    {
      name: "openai (openai-compat shaper)",
      providerId: "openai",
      model: "gpt-5",
      // OpenAI chat-completions: choices/delta content + a top-level "messages".
      lines: [
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        'data: {"choices":[{"finish_reason":"stop"}]}'
      ],
      expectBody: (body: Record<string, unknown>) => {
        expect(body.model).toBe("gpt-5");
        expect(body.stream).toBe(true);
        // Chat-completions uses "messages"; Anthropic also does but without the
        // "system" sibling and with max_tokens (asserted per-provider below).
        expect(Array.isArray(body.messages)).toBe(true);
      }
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
        'data: {"type":"message_stop"}'
      ],
      expectBody: (body: Record<string, unknown>) => {
        expect(body.model).toBe("claude-sonnet-4-6");
        expect(body.max_tokens).toBeDefined();
        // Anthropic's signature: stream + messages, NO stream_options/choices.
        expect(body.stream).toBe(true);
        expect(body.stream_options).toBeUndefined();
      }
    },
    {
      name: "gemini (generateContent shaper)",
      providerId: "gemini",
      model: "gemini-2.5-pro",
      // Gemini streams JSON-per-line with candidates/parts.
      lines: [
        '{"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]}}]}',
        '{"candidates":[{"finishReason":"STOP"}]}'
      ],
      expectBody: (body: Record<string, unknown>) => {
        expect(Array.isArray(body.contents)).toBe(true);
        // Gemini's signature: generationConfig + contents, NO model/messages.
        expect(body.generationConfig).toBeDefined();
        expect(body.model).toBeUndefined();
        expect(body.messages).toBeUndefined();
      }
    },
    {
      name: "xai (openai-compat shaper)",
      providerId: "xai",
      model: "grok-4",
      lines: [
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        'data: {"choices":[{"finish_reason":"stop"}]}'
      ],
      expectBody: (body: Record<string, unknown>) => {
        expect(body.model).toBe("grok-4");
        expect(body.stream).toBe(true);
        expect(Array.isArray(body.messages)).toBe(true);
      }
    },
    {
      name: "openrouter (openai-compat shaper)",
      providerId: "openrouter",
      model: "openrouter/auto",
      lines: [
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        'data: {"choices":[{"finish_reason":"stop"}]}'
      ],
      expectBody: (body: Record<string, unknown>) => {
        expect(body.model).toBe("openrouter/auto");
        expect(body.stream).toBe(true);
        expect(Array.isArray(body.messages)).toBe(true);
      }
    }
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
        capabilities: ["authentication", "streaming", "tool-requests", "approvals", "cancellation"],
        models: [{ id: model, label: model, available: true }]
      };
      const { result } = renderHook(() => useNativeAgent({ providers: [provider] }));

      await act(async () => {
        await result.current.run({
          model,
          messages: [{ role: "user", content: "hello" }],
          tools: [],
          maxTokens: 512
        });
      });

      // The desktop transport made exactly one egress call for the run.
      expect(mocks.streamRequests).toHaveLength(1);
      const egress = mocks.streamRequests[0];
      // The providerId + selected model thread through to the Rust boundary
      // (the key + endpoint are resolved from providerId inside Rust).
      expect(egress.providerId).toBe(providerId);
      expect(egress.model).toBe(model);
      // The body was shaped by this provider's shaper (the assertion above).
      expectBody(egress.body as Record<string, unknown>);
      // The run completed without surfacing an error.
      expect(result.current.state.running).toBe(false);
      expect(result.current.state.lastError).toBeNull();
    }
  );

  it("routes through the provider selected by the combined model picker", async () => {
    installDesktopRuntime();
    mocks.lines = [
      'data: {"choices":[{"delta":{"content":"selected"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}]}'
    ];
    const xai: BackendProvider = {
      ...connectedOpenAiProvider(),
      id: "xai",
      label: "xAI",
      models: [{ id: "grok-4", label: "Grok 4", available: true }]
    };
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedOpenAiProvider(), xai],
        activeProviderId: "xai"
      })
    );

    await act(async () => {
      await result.current.run({ ...baseRequest, model: "grok-4" });
    });

    expect(mocks.streamRequests).toHaveLength(1);
    expect(mocks.streamRequests[0]).toMatchObject({
      providerId: "xai",
      model: "grok-4"
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
          retryAfterMs: null
        }
      })
    ];
    // emitDone stays true, but the transport error short-circuits the run.

    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] })
    );

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(result.current.state.running).toBe(false);
    // The error is classified so a configuration failure (rejected/expired key)
    // is distinguishable from a runtime/provider failure: the surfaced message
    // points the user at their key in Settings and preserves the provider detail.
    expect(result.current.state.lastError).toContain("API key");
    expect(result.current.state.lastError).toContain("Settings");
    expect(result.current.state.lastError).toContain("Provider rejected the API key.");
  });

  it("runtime provider errors are classified as retryable, not as a key problem", async () => {
    installDesktopRuntime();
    // A 5xx surfaces as `provider-unavailable` — a runtime failure, not a
    // configuration one. The surfaced message must not point at the API key.
    mocks.lines = [
      JSON.stringify({
        __fableTransport: {
          kind: "error",
          code: "provider-unavailable",
          message: "Provider request failed with HTTP 503.",
          retryable: true,
          attempt: 3,
          retryAfterMs: null
        }
      })
    ];

    const { result } = renderHook(() =>
      useNativeAgent({ providers: [connectedOpenAiProvider()] })
    );

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(result.current.state.running).toBe(false);
    expect(result.current.state.lastError).toContain("unavailable");
    expect(result.current.state.lastError).toContain("HTTP 503");
    // A runtime error must never be mislabeled as an API-key problem.
    expect(result.current.state.lastError?.toLowerCase()).not.toContain("api key");
  });
});

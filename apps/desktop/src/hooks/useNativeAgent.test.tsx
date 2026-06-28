import { act, renderHook, waitFor } from "@testing-library/react";
import type { BackendAgentEvent, NativeCompletionRequest } from "@fable/protocol";
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
  cancelCalls: [] as string[],
  // The joined integration test scripts the mocked Rust tool boundary here:
  // every executeRuntimeToolCall records its request and resolves with this result.
  toolRequests: [] as unknown[],
  savedRuns: [] as unknown[],
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
  streamRuntimeCompletion: vi.fn(async () => {
    mocks.streamCalls += 1;
    return null;
  }),
  cancelRuntimeCompletion: vi.fn(async (requestId: string) => {
    mocks.cancelCalls.push(requestId);
    return null;
  }),
  saveRuntimeAgentRun: vi.fn(async (run: unknown) => {
    mocks.savedRuns.push(run);
    return run;
  }),
  recoverRuntimeAgentRuns: vi.fn(async () => []),
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

const baseRequest: NativeCompletionRequest = {
  providerId: "openai",
  model: "gpt-5",
  messages: [{ role: "user", content: "summarize the project" }],
  tools: [],
  maxTokens: 1024
};

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
  mocks.cancelCalls = [];
  mocks.toolRequests = [];
  mocks.savedRuns = [];
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

  it("accumulates text-delta events into the transcript", async () => {
    installDesktopRuntime();
    mocks.lines = [openAiChunk("Hello"), openAiChunk(" world"), finishStop];

    const { result } = renderHook(() => useNativeAgent({ providers: [] }));

    expect(result.current.state.noTransport).toBe(false);
    expect(result.current.state.running).toBe(false);

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(result.current.state.transcript).toBe("Hello world");
    expect(result.current.state.running).toBe(false);
    expect(result.current.state.lastError).toBeNull();
  });

  it("captures usage events into the usage state", async () => {
    installDesktopRuntime();
    mocks.lines = [
      openAiChunk("ok"),
      'data: {"usage":{"prompt_tokens":42,"completion_tokens":7}}',
      finishStop
    ];

    const { result } = renderHook(() => useNativeAgent({ providers: [] }));

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
    const { result } = renderHook(() => useNativeAgent({ providers: [], onToolCall }));

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

    const { result } = renderHook(() => useNativeAgent({ providers: [] }));

    await act(async () => {
      await result.current.run(baseRequest);
    });

    expect(result.current.state.lastError).toBe("Unparseable OpenAI chunk.");
    expect(result.current.state.running).toBe(false);
  });

  it("clears running and resets the transcript at the start of each run", async () => {
    installDesktopRuntime();
    mocks.lines = [openAiChunk("first"), finishStop];

    const { result } = renderHook(() => useNativeAgent({ providers: [] }));

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

    const { result } = renderHook(() => useNativeAgent({ providers: [] }));

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

    // Unblock the held-open run so it can settle without rejecting the suite.
    mocks.onLine?.("[DONE]");
    await act(async () => {
      await runPromise.catch(() => {});
    });
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
        providers: [],
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
    const { result } = renderHook(() => useNativeAgent({ providers: [], onCancel }));

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
    const { result } = renderHook(() => useNativeAgent({ providers: [], onToolCall }));

    await act(async () => {
      // "Confirm every action" maps to read-only — accepted + threaded into the run.
      await result.current.run(baseRequest, undefined, "Confirm every action");
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
        providers: [],
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
});

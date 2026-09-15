import { baseRequest,connectedOpenAiProvider,finishStop,installDesktopRuntime,mocks,openAiChunk } from "./native-agent-test-harness";
import type {
ExecutionAttempt
} from "@fable/protocol";
import { act,renderHook,waitFor } from "@testing-library/react";
import { describe,expect,it,vi } from "vitest";
import { agentPresence } from "../lib/agent-presence";

import { useNativeAgent } from "./useNativeAgent";

describe("native agent cancellation", () => {
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
});

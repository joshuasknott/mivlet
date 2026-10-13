import type { BackendAgentEvent, ExecutionAttempt } from "@mivlet/protocol";
import type { SetStateAction } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DurableRunRecord } from "../../lib/conversation-runtime";
import { createAttemptPersistence } from "../../lib/attempt-persistence";
import { consumeNativeAgentEvents, type NativeAgentEventSession } from "./events";
import { createInitialNativeAgentState } from "./runtime";
import { createTextPresentation } from "./text-presentation";
import type { NativeAgentState } from "./types";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  let state: NativeAgentState = {
    ...createInitialNativeAgentState(),
    currentAttemptId: "attempt",
    progressThreadId: "thread",
    running: true,
    status: "streaming",
    responseParts: [],
  };
  const updates: NativeAgentState[] = [];
  const checkpointAssistant = vi.fn(async (_text: string, _terminal?: boolean) => {});
  const record = vi.fn(async (_record: DurableRunRecord) => {});
  const save = vi.fn(async (_attempt: ExecutionAttempt) => {});
  const persistence = createAttemptPersistence(save);
  const writer = { checkpointAssistant, record };
  persistence.setWriter(writer);
  const persisted: ExecutionAttempt = {
    id: "attempt",
    threadId: "thread",
    providerId: "openai",
    model: "fixture",
    status: "streaming",
    transcript: "",
    exchanges: [],
    turn: 0,
    pendingApprovalIds: [],
    recoverable: true,
    retryCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  persistence.current = persisted;
  const session: NativeAgentEventSession = {
    persisted, persistence, durableWriter: writer, attemptId: "attempt", isScopeCurrent: () => true,
    setState: (update) => {
      state = typeof update === "function" ? update(state) : update;
      updates.push(state);
    },
    pendingApprovalByCall: new Map(),
    toolNameByCall: new Map(),
    lastPersistedTranscriptLength: 0,
    lastPersistedAt: Date.now(),
  };
  return { session, updates, checkpointAssistant, record, save,
    state: () => state,
    replace: (next: NativeAgentState) => { state = next; },
  };
}

async function* stream(events: BackendAgentEvent[]) {
  yield* events;
}

describe("native stream text presentation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("coalesces 100 deltas into one screen update while preserving every canonical checkpoint", async () => {
    const h = harness();
    const ready = deferred();
    const finish = deferred();
    async function* burst(): AsyncIterable<BackendAgentEvent> {
      for (let i = 0; i < 100; i++) yield { type: "text-delta", text: "ab" };
      ready.resolve();
      await finish.promise;
      yield { type: "done", finishReason: "stop" };
    }
    const consuming = consumeNativeAgentEvents(burst(), h.session);
    await ready.promise;

    expect(h.session.persistence.current?.transcript).toBe("ab".repeat(100));
    expect(h.checkpointAssistant).toHaveBeenCalledTimes(100);
    expect(h.checkpointAssistant).toHaveBeenLastCalledWith("ab".repeat(100), false);
    expect(h.state().transcript).toBe("");
    expect(h.updates).toHaveLength(0);

    vi.advanceTimersByTime(32);
    expect(h.updates).toHaveLength(1);
    expect(h.state().transcript).toBe("ab".repeat(100));
    expect(h.state().responseParts).toEqual([
      { id: "text-0", kind: "text", content: "ab".repeat(100) },
    ]);

    finish.resolve();
    await consuming;
    expect(h.state().status).toBe("completed");
    expect(h.checkpointAssistant).toHaveBeenLastCalledWith("ab".repeat(100), true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes text before approvals and preserves text/tool/text order without waiting for the timer", async () => {
    const h = harness();
    const onToolCall = vi.fn(() => expect(h.state().transcript).toBe("Before"));
    h.session.onToolCall = () => onToolCall;
    await consumeNativeAgentEvents(stream([
      { type: "text-delta", text: "Before" },
      { type: "tool-call", callId: "call", tool: "write-file", arguments: "{}",
        approval: { id: "approval", action: "write-file note", mode: "trusted-scope", riskLevel: "medium" } as never },
      { type: "tool-result", callId: "call", ok: true, output: "Saved" },
      { type: "text-delta", text: "After" },
      { type: "done", finishReason: "stop" },
    ]), h.session);

    expect(onToolCall).toHaveBeenCalledOnce();
    expect(h.updates.some((state) => state.status === "awaiting-approval")).toBe(true);
    expect(h.record.mock.calls.map(([entry]) => entry)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "approval-request", approvalRequestId: "approval" }),
      expect.objectContaining({ kind: "tool-result", content: "Saved" }),
    ]));
    expect(h.state().responseParts).toEqual([
      { id: "text-0", kind: "text", content: "Before" },
      expect.objectContaining({ kind: "tool", id: "call", state: "succeeded", content: "Saved" }),
      { id: "text-2", kind: "text", content: "After" },
    ]);
    expect(h.state().transcript).toBe("BeforeAfter");
    expect(h.session.persistence.current?.pendingApprovalIds).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { type: "cancelled" } as BackendAgentEvent,
    { type: "error", message: "Provider failure", retryable: true } as BackendAgentEvent,
  ])("flushes accepted text before $type", async (terminal) => {
    const h = harness();
    await consumeNativeAgentEvents(stream([
      { type: "text-delta", text: "Accepted" }, terminal,
    ]), h.session);
    expect(h.state().transcript).toBe("Accepted");
    expect(h.state().running).toBe(false);
    expect(h.state().status).toBe(terminal.type === "cancelled" ? "cancelled" : "failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes accepted text at EOF and on a thrown transport error", async () => {
    const eof = harness();
    await consumeNativeAgentEvents(stream([{ type: "text-delta", text: "EOF tail" }]), eof.session);
    expect(eof.state().transcript).toBe("EOF tail");
    expect(eof.state().status).toBe("failed");

    const thrown = harness();
    async function* broken(): AsyncIterable<BackendAgentEvent> {
      yield { type: "text-delta", text: "Exception tail" };
      throw new Error("transport lost");
    }
    await expect(consumeNativeAgentEvents(broken(), thrown.session)).rejects.toThrow("transport lost");
    expect(thrown.state().transcript).toBe("Exception tail");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes synchronously on Stop during a pending write and refuses late provider text", async () => {
    const h = harness();
    const entered = deferred();
    const release = deferred();
    h.checkpointAssistant.mockImplementation(async (_text, terminal) => {
      if (!terminal) {
        entered.resolve();
        await release.promise;
      }
    });
    const consuming = consumeNativeAgentEvents(stream([
      { type: "text-delta", text: "Accepted" },
      { type: "text-delta", text: " late" },
      { type: "done", finishReason: "stop" },
    ]), h.session);
    await entered.promise;
    expect(h.state().transcript).toBe("");
    expect(h.session.persistence.current?.transcript).toBe("Accepted");

    const stopping = h.session.persistence.stop();
    expect(h.state().transcript).toBe("Accepted");
    expect(h.session.persistence.current?.status).toBe("cancelled");
    expect(vi.getTimerCount()).toBe(0);
    release.resolve();
    await Promise.all([stopping, consuming]);
    expect(h.state().transcript).toBe("Accepted");
    expect(h.session.persistence.current?.transcript).toBe("Accepted");
    expect(h.checkpointAssistant).toHaveBeenLastCalledWith("Accepted", true);
    expect(h.record).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "interruption" }));
  });

  it.each(["thread", "attempt", "workspace"])("rejects pending presentation after switching the %s", async (scope) => {
    const h = harness();
    const ready = deferred();
    const finish = deferred();
    async function* waiting(): AsyncIterable<BackendAgentEvent> {
      yield { type: "text-delta", text: "Old account's output" };
      ready.resolve();
      await finish.promise;
      yield { type: "done", finishReason: "stop" };
    }
    let currentScope = true;
    h.session.isScopeCurrent = () => currentScope;
    const consuming = consumeNativeAgentEvents(waiting(), h.session);
    await ready.promise;
    if (scope === "workspace") currentScope = false;
    h.replace({
      ...h.state(), transcript: "New view",
      ...(scope === "thread" ? { progressThreadId: "other-thread" } : scope === "attempt" ? { currentAttemptId: "other-attempt" } : {}),
    });
    vi.advanceTimersByTime(32);
    expect(h.state().transcript).toBe("New view");
    finish.resolve();
    await consuming;
    expect(h.state().transcript).toBe("New view");
  });

  it("delivers accepted queued text after completion while that attempt is still the visible one", () => {
    const queued: SetStateAction<NativeAgentState>[] = [];
    const presentation = createTextPresentation((update) => queued.push(update), "attempt", "thread", () => true);
    presentation.append("Final answer");
    presentation.flush();
    const current: NativeAgentState = {
      ...createInitialNativeAgentState(), currentAttemptId: "attempt", progressThreadId: "thread", status: "completed",
    };
    const update = queued[0]!;
    expect(typeof update === "function" ? update(current) : update).toMatchObject({
      transcript: "Final answer", status: "completed", running: false,
    });
  });

  it("rechecks scope when React evaluates an already queued updater", () => {
    const queued: SetStateAction<NativeAgentState>[] = [];
    const presentation = createTextPresentation((update) => queued.push(update), "attempt", "thread", () => true);
    presentation.append("old text");
    presentation.flush();
    const current = { ...createInitialNativeAgentState(), currentAttemptId: "new-attempt", progressThreadId: "thread" };
    const update = queued[0]!;
    expect(typeof update === "function" ? update(current) : update).toBe(current);
    expect(vi.getTimerCount()).toBe(0);
  });
});

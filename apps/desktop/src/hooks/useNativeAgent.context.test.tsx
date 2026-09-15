import { baseRequest,connectedCodexProvider,connectedOpenAiProvider,finishStop,installDesktopRuntime,mocks,openAiChunk } from "./native-agent-test-harness";
import type {
ExecutionAttempt
} from "@mivlet/protocol";
import { act,renderHook,waitFor } from "@testing-library/react";
import { describe,expect,it,vi } from "vitest";
import type { DurableRunWriter } from "../lib/conversation-runtime";
import { listRuntimeContextSummaries,saveRuntimeContextSummary } from "../runtime/domains/memory";

import { useNativeAgent } from "./useNativeAgent";

describe("native agent context", () => {
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

  it("compacts oversized Codex history through a durable summary before egress", async () => {
    installDesktopRuntime();
    mocks.codexEvents = [{ type: "done", finishReason: "stop" }];
    vi.mocked(listRuntimeContextSummaries).mockResolvedValue([]);
    const saveSummary = vi.mocked(saveRuntimeContextSummary);
    saveSummary.mockImplementation(async (summary) => summary);
    const record = vi.fn(async () => undefined);
    const messages = Array.from({ length: 40 }, (_, index) => ({
      message: {
        kind: index % 2 === 0 ? "user" : "assistant",
        sequence: index + 1,
      },
      currentRevision: {
        state: "terminal",
        content: `turn ${index + 1} ${"detail ".repeat(300)}`,
      },
    }));
    const { result } = renderHook(() =>
      useNativeAgent({
        providers: [connectedCodexProvider()],
        activeProviderId: "codex",
        computer: { workspaceId: "workspace-1", agentId: "agent-1" },
        contextOwner: { internalUserId: "user-1", memberId: "member-1" },
        threadId: "thread-1",
        loadConversation: async () =>
          ({ thread: { id: "thread-1" }, messages }) as never,
        createDurableRunWriter: () => ({
          record,
          checkpointAssistant: vi.fn(async () => undefined),
        }),
      }),
    );

    await act(async () => {
      await result.current.run({ ...baseRequest, model: "gpt-5" });
    });

    expect(result.current.state.contextFailure).toBeUndefined();
    expect(result.current.state.lastError).toBeNull();
    expect(saveSummary).toHaveBeenCalledTimes(1);
    const saved = saveSummary.mock.calls[0][0];
    expect(saved.threadId).toBe("thread-1");
    expect(saved.revision).toBe(1);
    expect(saved.throughSequence).toBeGreaterThan(0);
    expect(saved.fromSequence).toBe(1);
    expect(record).toHaveBeenCalled();
    expect(mocks.savedRuns.length).toBeGreaterThan(0);
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
    const { startRuntimeCodexTurn } = await import("../runtime/domains/providers");
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
});

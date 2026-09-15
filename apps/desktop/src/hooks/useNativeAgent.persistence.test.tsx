import { baseRequest,connectedCodexProvider,connectedOpenAiProvider,finishStop,installDesktopRuntime,mocks,openAiChunk,preparedContext } from "./native-agent-test-harness";
import type {
AgentTurnRequest,
ExecutionAttempt
} from "@fable/protocol";
import { act,renderHook,waitFor } from "@testing-library/react";
import { describe,expect,it,vi } from "vitest";
import type { DurableRunWriter } from "../lib/conversation-runtime";

import { useNativeAgent } from "./useNativeAgent";

describe("native agent persistence", () => {
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
});

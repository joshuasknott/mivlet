import { baseRequest, connectedOpenAiProvider, finishStop, installDesktopRuntime, mocks, openAiChunk } from "./native-agent-test-harness";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionAttempt } from "@mivlet/protocol";
import type { DurableRunWriter } from "../lib/conversation-runtime";
import { useNativeAgent } from "./useNativeAgent";

describe("native provider continuation integration", () => {
  it("sends transferred history before newer task replies and persists only the current request", async () => {
    installDesktopRuntime();
    mocks.lines = [openAiChunk("New answer"), finishStop];
    const record = vi.fn(async (_entry: Parameters<DurableRunWriter["record"]>[0]) => {});
    const { result } = renderHook(() => useNativeAgent({
      providers: [connectedOpenAiProvider()], threadId: "thread-1",
      loadConversation: async () => ({
        thread: { id: "thread-1" },
        messages: [{
          message: { kind: "assistant", sequence: 1 },
          currentRevision: { state: "terminal", content: "Newer task contribution" },
        }],
      }) as never,
      createDurableRunWriter: () => ({ record, checkpointAssistant: vi.fn(async () => {}) }),
    }));
    const request = { ...baseRequest, messages: [{ role: "user" as const, content: "  Exact next request\n" }] };
    await act(async () => { await result.current.run(request, undefined, undefined, undefined, {
      historyPrefix: [
        { role: "user", content: "Historical constraints" },
        { role: "assistant", content: "Older provider's public reply" },
      ],
    }); });
    const messages = (mocks.streamRequests[0].body as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages.filter(m => m.role !== "system").map(m => m.content)).toEqual([
      "Historical constraints", "Older provider's public reply", "Newer task contribution", "  Exact next request\n",
    ]);
    expect(record.mock.calls.filter(([entry]) => entry.kind === "user")).toEqual([
      [{ kind: "user", content: "  Exact next request\n" }],
    ]);
    const saved = mocks.savedRuns.at(-1) as ExecutionAttempt;
    expect(saved.exchanges?.filter(entry => entry.role === "user")).toHaveLength(1);
    expect(JSON.stringify(saved)).not.toContain("Historical constraints");
  });
});

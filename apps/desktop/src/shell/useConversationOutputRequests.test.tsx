import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutputRevisionRequest } from "../lib/output-revisions";
import { emitOutputRevisionRequest } from "../lib/output-revision-events";
import { conversationUi } from "../runtime/domains/conversation-ui";
import { useConversationOutputRequests } from "./useConversationOutputRequests";

vi.mock("../runtime/domains/conversation-ui", () => ({
  conversationUi: vi.fn(),
}));
const request = (outputId: string): OutputRevisionRequest => ({
  outputId,
  expectedRevisionId: `revision-${outputId}`,
  expectedRevisionNumber: 2,
  content: "saved content",
  selection: "paragraph 1",
  source: { conversationId: "chat" },
});
function setup() {
  const setText = vi.fn();
  const hook = renderHook(
    ({ conversationId, active }) =>
      useConversationOutputRequests({
        conversationId,
        active,
        runtime: { addChatMemory: vi.fn() },
        composer: { current: { setText } },
        focus: vi.fn(),
        setError: vi.fn(),
      }),
    { initialProps: { conversationId: "chat", active: true } },
  );
  return { ...hook, setText };
}
beforeEach(() => vi.resetAllMocks());

describe("source-bound output requests", () => {
  it("stages the exact selected revision through native authority", async () => {
    const { result, setText } = setup();
    act(() =>
      emitOutputRevisionRequest({
        kind: "text",
        conversationId: "chat",
        request: request("a"),
      }),
    );
    expect(setText).toHaveBeenCalledWith(
      expect.stringContaining("saved content"),
    );
    let workId: string | undefined;
    await act(async () => {
      workId = await result.current.stageOutputRevision({
        workspaceId: "workspace",
        agentId: "mira",
        prompt: "refine it",
        replying: false,
      });
    });
    expect(conversationUi).toHaveBeenCalledWith(
      { workspaceId: "workspace", conversationId: "chat", agentId: "mira" },
      expect.objectContaining({
        action: "stage-output-revision",
        workId,
        outputId: "a",
        expectedRevisionId: "revision-a",
        expectedRevisionNumber: 2,
        prompt: "refine it",
      }),
    );
  });
  it("completion of an older request cannot discard a newer selected revision", () => {
    const { result } = setup();
    act(() => result.current.requestOutputRevision(request("a")));
    const completeOld = result.current.clearOutputRevision;
    act(() => result.current.requestOutputRevision(request("b")));
    act(() => completeOld());
    expect(result.current.pendingOutputRevision?.outputId).toBe("b");
  });
  it("does not stage a revision in a different conversation or during a reply", async () => {
    const { result, rerender } = setup();
    act(() => result.current.requestOutputRevision(request("a")));
    await expect(
      result.current.stageOutputRevision({
        workspaceId: "workspace",
        agentId: "mira",
        prompt: "refine it",
        replying: true,
      }),
    ).rejects.toThrow("pending reply");
    rerender({ conversationId: "other-chat", active: true });
    await expect(
      result.current.stageOutputRevision({
        workspaceId: "workspace",
        agentId: "mira",
        prompt: "refine it",
        replying: false,
      }),
    ).resolves.toBeUndefined();
    expect(conversationUi).not.toHaveBeenCalled();
  });
  it("ignores output events for inactive or unrelated panes", () => {
    const { result, rerender, setText } = setup();
    act(() =>
      emitOutputRevisionRequest({
        kind: "text",
        conversationId: "other-chat",
        request: request("a"),
      }),
    );
    rerender({ conversationId: "chat", active: false });
    act(() =>
      emitOutputRevisionRequest({
        kind: "text",
        conversationId: "chat",
        request: request("b"),
      }),
    );
    expect(result.current.pendingOutputRevision).toBeNull();
    expect(setText).not.toHaveBeenCalled();
  });
});

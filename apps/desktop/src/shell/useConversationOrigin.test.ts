import { waitFor } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useConversationOrigin } from "./useConversationOrigin";
import type { HydratedConversation } from "../lib/conversation-runtime";
import { selectRuntimeConversationBranch } from "../runtime/domains/conversations";

vi.mock("../runtime/domains/conversations", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../runtime/domains/conversations")
  >();
  return { ...actual, selectRuntimeConversationBranch: vi.fn() };
});

const initialHistory = (selectedHeadId = "branch-1") =>
  ({
    thread: {
      id: "conversation-1",
      messageHead: {
        selectedHeadId,
        lastMessageId: "message-7",
        lastSequence: 7,
      },
    },
    messages: [
      {
        message: {
          id: "message-7",
          currentRevisionId: "revision-3",
        },
        currentRevision: {},
      },
    ],
  }) as unknown as HydratedConversation;

function setup(status?: string) {
  let history = initialHistory();
  const snapshot = {
    data: {
      work: status
        ? [{ conversationId: "conversation-1", status }]
        : [],
    },
    histories: { "conversation-1": history },
  };
  const service = {
    getSnapshot: () => snapshot,
    loadHistory: vi.fn(async () => undefined),
    loadOlderHistory: vi.fn(async () => false),
  };
  return {
    snapshot,
    service,
    updateHistory(next: HydratedConversation) {
      history = next;
      snapshot.histories["conversation-1"] = next;
    },
  };
}

describe("useConversationOrigin", () => {
  it("selects the saved branch with the native CAS and focuses its source after reload", async () => {
    vi.mocked(selectRuntimeConversationBranch).mockResolvedValueOnce(
      undefined as never,
    );
    const setupState = setup();
    const root = document.createElement("div");
    const target = document.createElement("article");
    target.dataset.conversationMessageId = "message-7";
    target.dataset.conversationRevisionId = "revision-3";
    root.append(target);
    document.body.append(root);
    const contentRef = { current: root };
    const clearOrigin = vi.fn();
    const onNotice = vi.fn();
    const { result } = renderHook(() =>
      useConversationOrigin({
        origin: {
          conversationId: "conversation-1",
          branchId: "branch-2",
          messageId: "message-7",
          sourceRevisionId: "revision-3",
        },
        roomId: "conversation-1",
        active: true,
        history: setupState.snapshot.histories["conversation-1"],
        service: setupState.service as never,
        work: [],
        contentRef,
        clearOrigin,
        onNotice,
      }),
    );

    await waitFor(() => expect(target).toHaveFocus());
    expect(clearOrigin).toHaveBeenCalledTimes(1);
    expect(selectRuntimeConversationBranch).toHaveBeenCalledWith(
      "conversation-1",
      "branch-2",
      { headId: "branch-1", lastSequence: 7 },
    );
    expect(target).toHaveFocus();
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("loads bounded older pages until an exact saved source is available", async () => {
    const setupState = setup();
    setupState.updateHistory({
      ...setupState.snapshot.histories["conversation-1"],
      olderCursor: "7",
      hasOlderMessages: true,
    } as HydratedConversation);
    const root = document.createElement("div");
    const target = document.createElement("article");
    target.dataset.conversationMessageId = "message-1";
    root.append(target);
    document.body.append(root);
    let resolveOlder!: (loaded: boolean) => void;
    setupState.service.loadOlderHistory = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          setupState.updateHistory({
            ...setupState.snapshot.histories["conversation-1"],
            messages: [
              ...(setupState.snapshot.histories["conversation-1"]?.messages ?? []),
              { message: { id: "message-1", currentRevisionId: "revision-1" }, currentRevision: {} },
            ],
            hasOlderMessages: false,
          } as HydratedConversation);
          resolveOlder = resolve;
        }),
    );
    const clearOrigin = vi.fn();
    const onNotice = vi.fn();
    const contentRef = { current: root };
    const initialProps = {
      origin: { conversationId: "conversation-1", messageId: "message-1" },
      roomId: "conversation-1",
      active: true,
      history: setupState.snapshot.histories["conversation-1"],
      service: setupState.service as never,
      work: [],
      contentRef,
      clearOrigin,
      onNotice,
    };
    const hook = renderHook(
      (props) => useConversationOrigin(props),
      { initialProps },
    );
    await waitFor(() =>
      expect(setupState.service.loadOlderHistory).toHaveBeenCalledWith(
        "conversation-1",
      ),
    );
    hook.rerender({
      ...initialProps,
      history: setupState.snapshot.histories["conversation-1"],
    });
    resolveOlder(true);
    await waitFor(() => expect(target).toHaveFocus());
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("pages to a branch-only origin head that is outside the newest window", async () => {
    vi.mocked(selectRuntimeConversationBranch).mockResolvedValueOnce(
      undefined as never,
    );
    const setupState = setup();
    setupState.updateHistory({
      ...setupState.snapshot.histories["conversation-1"],
      olderCursor: "7",
      hasOlderMessages: true,
    } as HydratedConversation);
    setupState.service.loadOlderHistory = vi.fn(async () => {
      setupState.updateHistory({
        ...setupState.snapshot.histories["conversation-1"],
        messages: [
          ...(setupState.snapshot.histories["conversation-1"]?.messages ?? []),
          { message: { id: "branch-2", currentRevisionId: "revision-2" }, currentRevision: {} },
        ],
        hasOlderMessages: false,
      } as HydratedConversation);
      return true;
    });
    const clearOrigin = vi.fn();
    const onNotice = vi.fn();
    const contentRef = { current: document.createElement("div") };
    renderHook(() =>
      useConversationOrigin({
        origin: { conversationId: "conversation-1", branchId: "branch-2" },
        roomId: "conversation-1",
        active: true,
        history: setupState.snapshot.histories["conversation-1"],
        service: setupState.service as never,
        work: [],
        contentRef,
        clearOrigin,
        onNotice,
      }),
    );
    await waitFor(() =>
      expect(setupState.service.loadOlderHistory).toHaveBeenCalledWith(
        "conversation-1",
      ),
    );
    expect(selectRuntimeConversationBranch).toHaveBeenCalledWith(
      "conversation-1",
      "branch-2",
      { headId: "branch-1", lastSequence: 7 },
    );
    await waitFor(() => expect(clearOrigin).toHaveBeenCalledTimes(1));
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("refuses active or uncertain work without selecting a branch", async () => {
    vi.mocked(selectRuntimeConversationBranch).mockClear();
    const setupState = setup("running");
    const clearOrigin = vi.fn();
    const onNotice = vi.fn();
    const contentRef = { current: document.createElement("div") };
    renderHook(() =>
      useConversationOrigin({
        origin: {
          conversationId: "conversation-1",
          branchId: "branch-2",
        },
        roomId: "conversation-1",
        active: true,
        history: setupState.snapshot.histories["conversation-1"],
        service: setupState.service as never,
        work: [],
        contentRef,
        clearOrigin,
        onNotice,
      }),
    );

    await waitFor(() => expect(onNotice).toHaveBeenCalled());
    expect(clearOrigin).not.toHaveBeenCalled();
    expect(selectRuntimeConversationBranch).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith(
      "This conversation has active or uncertain work. Stop or review it before opening another branch.",
    );
  });
});

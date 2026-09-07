import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDurableConversation } from "./useDurableConversation";

const mocks = vi.hoisted(() => ({
  listThreads: vi.fn(),
  getThread: vi.fn(),
  listMessages: vi.fn(),
  loadDraft: vi.fn(),
  deleteThread: vi.fn(),
}));

vi.mock("../runtime", () => ({
  createRuntimeConversationThread: vi.fn(),
  listRuntimeConversationThreads: mocks.listThreads,
  getRuntimeConversationThread: mocks.getThread,
  updateRuntimeConversationThread: vi.fn(),
  listRuntimeConversationMessages: mocks.listMessages,
  appendRuntimeConversationMessage: vi.fn(),
  reviseRuntimeConversationMessage: vi.fn(),
  loadRuntimeConversationDraft: mocks.loadDraft,
  saveRuntimeConversationDraft: vi.fn(async (draft) => draft),
  deleteRuntimeConversationDraft: vi.fn(async () => {}),
  deleteRuntimeConversationThread: mocks.deleteThread,
}));

const thread = (id: string) => ({
  id,
  workspaceId: "workspace",
  title: id,
  lifecycle: "active",
  messageHead: { lastSequence: 0 },
});

describe("useDurableConversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listThreads.mockResolvedValue([]);
    mocks.getThread.mockResolvedValue(null);
    mocks.listMessages.mockResolvedValue([]);
    mocks.loadDraft.mockResolvedValue(null);
    mocks.deleteThread.mockReset().mockResolvedValue(undefined);
  });

  it("removes a deleted thread and its open transcript only after storage succeeds", async () => {
    mocks.listThreads.mockResolvedValue([thread("old"), thread("keep")]);
    mocks.getThread.mockResolvedValue(thread("old"));
    const { result } = renderHook(() => useDurableConversation({ workspaceId: "workspace", threadId: "old" }));
    await waitFor(() => expect(result.current.state.conversation?.thread.id).toBe("old"));
    mocks.deleteThread.mockRejectedValueOnce(new Error("Busy"));
    await act(async () => { await expect(result.current.deleteThread("old")).rejects.toThrow("Busy"); });
    expect(result.current.state.threads).toHaveLength(2);
    await act(async () => result.current.deleteThread("old"));
    expect(result.current.state.threads.map((item) => item.id)).toEqual(["keep"]);
    expect(result.current.state.conversation).toBeNull();
    expect(mocks.deleteThread).toHaveBeenCalledWith("old");
  });

  it("waits for the installation-local workspace boundary before hydrating", async () => {
    const initialProps: { workspaceId?: string } = { workspaceId: undefined };
    const { result, rerender } = renderHook(
      ({ workspaceId }: { workspaceId?: string }) =>
        useDurableConversation({ workspaceId }),
      { initialProps },
    );

    await waitFor(() => expect(result.current.state.loading).toBe(false));
    expect(result.current.state.error).toBeNull();
    expect(mocks.listThreads).not.toHaveBeenCalled();
    expect(mocks.loadDraft).not.toHaveBeenCalled();

    rerender({ workspaceId: "default" });

    await waitFor(() => expect(mocks.listThreads).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.state.loading).toBe(false));
    expect(result.current.state.error).toBeNull();
    expect(mocks.loadDraft).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale thread hydration overwrite the newly selected thread", async () => {
    let resolveOld!: (value: unknown) => void;
    mocks.getThread.mockImplementation((id: string) =>
      id === "old"
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(thread("new")),
    );
    mocks.listMessages.mockResolvedValue([]);

    const { result, rerender } = renderHook(
      ({ threadId }) =>
        useDurableConversation({ workspaceId: "workspace", threadId }),
      { initialProps: { threadId: "old" } },
    );
    rerender({ threadId: "new" });
    await waitFor(() =>
      expect(result.current.state.conversation?.thread.id).toBe("new"),
    );
    resolveOld(thread("old"));
    await act(async () => {});

    expect(result.current.state.conversation?.thread.id).toBe("new");
  });

  it("uses a stable draft key before a thread exists", async () => {
    const { result } = renderHook(() =>
      useDurableConversation({ workspaceId: "workspace" }),
    );
    await act(async () => {});
    expect(result.current.draftKey).toBe("new-thread");
    expect(mocks.loadDraft).toHaveBeenCalledWith("new-thread");
  });
});

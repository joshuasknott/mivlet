import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDurableConversation } from "./useDurableConversation";

const mocks = vi.hoisted(() => ({
  listThreads: vi.fn(),
  getThread: vi.fn(),
  listMessages: vi.fn(),
  loadDraft: vi.fn()
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
  deleteRuntimeConversationDraft: vi.fn(async () => {})
}));

const thread = (id: string) => ({ id, workspaceId: "workspace", title: id, lifecycle: "active", messageHead: { lastSequence: 0 } });

describe("useDurableConversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listThreads.mockResolvedValue([]);
    mocks.getThread.mockResolvedValue(null);
    mocks.listMessages.mockResolvedValue([]);
    mocks.loadDraft.mockResolvedValue(null);
  });

  it("does not let a stale thread hydration overwrite the newly selected thread", async () => {
    let resolveOld!: (value: unknown) => void;
    mocks.getThread.mockImplementation((id: string) => id === "old"
      ? new Promise((resolve) => { resolveOld = resolve; })
      : Promise.resolve(thread("new")));
    mocks.listMessages.mockResolvedValue([]);

    const { result, rerender } = renderHook(
      ({ threadId }) => useDurableConversation({ workspaceId: "workspace", threadId }),
      { initialProps: { threadId: "old" } }
    );
    rerender({ threadId: "new" });
    await waitFor(() => expect(result.current.state.conversation?.thread.id).toBe("new"));
    resolveOld(thread("old"));
    await act(async () => {});

    expect(result.current.state.conversation?.thread.id).toBe("new");
  });

  it("uses a stable draft key before a thread exists", async () => {
    const { result } = renderHook(() =>
      useDurableConversation({ workspaceId: "workspace", projectId: "project-a" })
    );
    await act(async () => {});
    expect(result.current.draftKey).toBe("new-thread:project-a");
    expect(mocks.loadDraft).toHaveBeenCalledWith("new-thread:project-a");
  });
});

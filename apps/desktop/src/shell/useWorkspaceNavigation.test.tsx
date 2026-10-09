import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWorkspaceNavigation } from "./useWorkspaceNavigation";
vi.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));

describe("conversation-only navigation", () => {
  it("opens an activity in its owning conversation without dispatching execution", () => {
    const state = {
      loading: false, sessions: [],
      data: { conversations: [{ id: "chat-a" }, { id: "chat-b" }], teams: [],
        work: [{ id: "activity-b", conversationId: "chat-b", agentId: "agent" }] },
    };
    const command = vi.fn(async () => {});
    const options = { runtime: { agents: [], openApprovals: [] }, state,
      service: { getSnapshot: () => state, command, report: vi.fn() }, projects: [], marketplace: false,
      onNavigate: vi.fn(), onSearch: vi.fn() } as unknown as Parameters<typeof useWorkspaceNavigation>[0];
    const { result } = renderHook(() => useWorkspaceNavigation(options));
    act(() => result.current.selectNavWork("activity-b"));
    expect(result.current.activeRoom?.id).toBe("chat-b");
    expect(result.current.navWorkId).toBe("activity-b");
    expect(command).not.toHaveBeenCalled();
    act(() => result.current.selectNavWork(null));
    expect(result.current.activeRoom?.id).toBe("chat-b");
    expect(result.current.navWorkId).toBeNull();
    act(() => result.current.selectNavWork("missing"));
    expect(result.current.activeRoom?.id).toBe("chat-b");
  });

  it("keeps output origin metadata as a pending conversation deep link", () => {
    const state = {
      loading: false,
      sessions: [],
      data: {
        conversations: [{ id: "chat-a" }, { id: "chat-b" }],
        teams: [],
        work: [],
      },
    };
    const command = vi.fn(async () => {});
    const options = {
      runtime: { agents: [], openApprovals: [] },
      state,
      service: {
        getSnapshot: () => state,
        command,
        report: vi.fn(),
      },
      projects: [],
      marketplace: false,
      onNavigate: vi.fn(),
      onSearch: vi.fn(),
    } as unknown as Parameters<typeof useWorkspaceNavigation>[0];
    const { result } = renderHook(() => useWorkspaceNavigation(options));

    act(() =>
      result.current.openConversation("chat-a", {
        branchId: "branch-2",
        messageId: "message-7",
        sourceRevisionId: "revision-3",
      }),
    );
    expect(result.current.conversationOrigin).toEqual({
      conversationId: "chat-a",
      branchId: "branch-2",
      messageId: "message-7",
      sourceRevisionId: "revision-3",
    });
    expect(command).not.toHaveBeenCalled();

    // A normal conversation navigation clears the consumed/stale deep link.
    act(() => result.current.open("chat-b"));
    expect(result.current.conversationOrigin).toBeNull();
  });
});

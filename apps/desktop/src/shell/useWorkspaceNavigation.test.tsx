import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ConversationLayout } from "@mivlet/protocol";
import { useWorkspaceNavigation } from "./useWorkspaceNavigation";
import { WorkspaceRightNav } from "../components/navigation/WorkspaceRightNav";
import type { RightPanelTab } from "../components/navigation/right-panel-state";
vi.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));

function conversationLayout(ids: string[], activeId = ids.at(-1)!): ConversationLayout {
  const views = ids.map((id) => ({
    id: `view-${id}`,
    kind: "conversation" as const,
    conversationId: id,
  }));
  return {
    version: 2 as const,
    panes: [views.map((view) => view.id)],
    views,
    active: [`view-${activeId}`],
    activePane: 0,
    tree: { kind: "pane" as const, pane: 0 },
    closed: [],
  };
}

function navigationOptions(ids: string[], layout = conversationLayout(ids)) {
  const state = {
    loading: false,
    sessions: [],
    data: {
      conversations: ids.map((id) => ({ id })),
      teams: [],
      work: [],
      layout,
    },
  };
  const command = vi.fn(async () => {});
  const options = {
    runtime: { agents: [], openApprovals: [] },
    state,
    service: { getSnapshot: () => state, command, report: vi.fn() },
    projects: [],
    marketplace: false,
    onNavigate: vi.fn(),
    onSearch: vi.fn(),
  } as unknown as Parameters<typeof useWorkspaceNavigation>[0];
  return { options, state, command };
}

describe("conversation-only navigation", () => {
  it("reopens the same saved row after returning to Files", () => {
    const state = { loading: false, sessions: [], data: { conversations: [], teams: [], work: [] } };
    const options = { runtime: { agents: [], openApprovals: [] }, state,
      service: { getSnapshot: () => state, command: vi.fn(async () => {}), report: vi.fn() },
      projects: [], marketplace: false, onNavigate: vi.fn(), onSearch: vi.fn(),
    } as unknown as Parameters<typeof useWorkspaceNavigation>[0];
    const file: RightPanelTab = { id: "file:brief", kind: "web", title: "Brief", url: "https://example.com/brief" };
    function Workspace() {
      const nav = useWorkspaceNavigation(options);
      return <WorkspaceRightNav context={null} open={nav.contextOpen} onOpen={() => nav.setContextOpen(true)} onClose={() => nav.setContextOpen(false)} request={nav.panelRequest}
        library={<button onClick={() => nav.setPanelRequest(file)}>Open brief</button>}
        renderTab={() => <p>Saved brief contents</p>} />;
    }
    render(<Workspace />);
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    for (let visit = 0; visit < 2; visit++) {
      fireEvent.click(screen.getByRole("button", { name: "Open brief" }));
      expect(screen.getByText("Saved brief contents")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      expect(screen.getByRole("button", { name: "Open brief" })).toBeVisible();
    }
  });

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
    expect(result.current.contextOpen).toBe(false);
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
    expect(result.current.contextOpen).toBe(false);
    expect(command).not.toHaveBeenCalled();

    // A normal conversation navigation clears the consumed/stale deep link.
    act(() => result.current.open("chat-b"));
    expect(result.current.conversationOrigin).toBeNull();
    expect(result.current.contextOpen).toBe(false);
  });

  it("tracks focused conversation tabs and restores back/forward history", () => {
    const layout: ConversationLayout = {
      ...conversationLayout(["chat-a", "chat-b"], "chat-a"),
      panes: [["view-chat-a"], ["view-chat-b"]],
      active: ["view-chat-a", "view-chat-b"],
      tree: {
        kind: "split" as const,
        axis: "row" as const,
        ratio: 0.5,
        children: [
          { kind: "pane" as const, pane: 0 },
          { kind: "pane" as const, pane: 1 },
        ] as [
          { kind: "pane"; pane: number },
          { kind: "pane"; pane: number },
        ],
      },
    };
    const { options, command } = navigationOptions(
      ["chat-a", "chat-b"],
      layout,
    );
    const { result } = renderHook(() => useWorkspaceNavigation(options), {
      wrapper: StrictMode,
    });

    expect(result.current.activeRoom?.id).toBe("chat-a");
    expect(result.current.canGoBack).toBe(false);
    act(() => result.current.actLayout({ type: "activate", id: "view-chat-b" }));
    expect(result.current.activeRoom?.id).toBe("chat-b");
    expect(result.current.canGoBack).toBe(true);
    act(() => result.current.actLayout({ type: "activate", id: "view-chat-a" }));
    expect(result.current.activeRoom?.id).toBe("chat-a");
    expect(result.current.canGoForward).toBe(false);

    act(() => result.current.goBack());
    expect(result.current.activeRoom?.id).toBe("chat-b");
    expect(result.current.canGoForward).toBe(true);
    act(() => result.current.goForward());
    expect(result.current.activeRoom?.id).toBe("chat-a");
    expect(result.current.canGoForward).toBe(false);
    expect(command).not.toHaveBeenCalled();
  });

  it("truncates forward history after a new navigation and skips deleted rooms", () => {
    const { options, state } = navigationOptions(
      ["chat-a", "chat-b", "chat-c", "chat-d"],
      conversationLayout(["chat-a"], "chat-a"),
    );
    const { result, rerender } = renderHook(() => useWorkspaceNavigation(options));

    act(() => result.current.open("chat-b"));
    act(() => result.current.open("chat-c"));
    act(() => result.current.goBack());
    expect(result.current.activeRoom?.id).toBe("chat-b");
    act(() => result.current.open("chat-d"));
    expect(result.current.canGoForward).toBe(false);
    act(() => result.current.goBack());
    expect(result.current.activeRoom?.id).toBe("chat-b");
    act(() => result.current.goForward());
    expect(result.current.activeRoom?.id).toBe("chat-d");

    act(() => result.current.goBack());
    state.data.conversations = [{ id: "chat-a" }, { id: "chat-d" }];
    rerender();
    act(() => result.current.goBack());
    expect(result.current.activeRoom?.id).toBe("chat-a");
  });

  it("advances the history cursor when a deleted entry resolves to the current room", () => {
    const { options, state } = navigationOptions(
      ["chat-a", "chat-b"],
      conversationLayout(["chat-a"], "chat-a"),
    );
    const { result, rerender } = renderHook(() => useWorkspaceNavigation(options));

    act(() => result.current.open("chat-b"));
    act(() => result.current.open("chat-a"));
    state.data.conversations = [{ id: "chat-a" }];
    rerender();
    act(() => result.current.goBack());

    expect(result.current.activeRoom?.id).toBe("chat-a");
    expect(result.current.canGoBack).toBe(false);
  });

  it("keeps conversation history bounded while retaining the newest entries", () => {
    const ids = Array.from({ length: 106 }, (_, index) => `chat-${index}`);
    const { options } = navigationOptions(ids, conversationLayout(["chat-0"], "chat-0"));
    const { result } = renderHook(() => useWorkspaceNavigation(options));

    for (const id of ids.slice(1)) act(() => result.current.open(id));
    for (let index = 0; index < 99; index += 1) act(() => result.current.goBack());

    expect(result.current.activeRoom?.id).toBe("chat-6");
    expect(result.current.canGoBack).toBe(false);
  });
});

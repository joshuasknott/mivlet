import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRightNav } from "./WorkspaceRightNav";
import type { RightPanelTab } from "./right-panel-state";

const media = vi.hoisted(() => ({ compact: false }));
vi.mock("../../hooks/useMediaQuery", () => ({
  useMediaQuery: () => media.compact,
}));
const request: RightPanelTab = {
  id: "file:brief",
  kind: "web",
  title: "Launch brief",
  url: "https://example.com",
};
const base = () => ({
  context: null,
  identity: "workspace:chat",
  title: "Launch planning",
  open: true,
  onOpen: vi.fn(),
  onClose: vi.fn(),
  onCloseComputer: vi.fn(),
  onChatActiveChange: vi.fn(),
});
beforeEach(() => {
  media.compact = false;
});

describe("contextual workspace panel", () => {
  it("keeps the rail available when an agent or project inspector replaces the page", () => {
    const props = base();
    render(<WorkspaceRightNav {...props} replaced activity={() => <p>Retained Activity</p>} />);
    expect(screen.getByRole("tablist")).toBeVisible();
    expect(screen.getByText("Retained Activity")).not.toBeVisible();
    expect(screen.getByLabelText("Workspace panel")).toHaveAttribute("data-replaced", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(props.onOpen).toHaveBeenCalledOnce();
    expect(props.onClose).not.toHaveBeenCalled();
  });


  it("announces dock targets and releases replaced apps without closing the next inspector", () => {
    const ready = vi.fn();
    const closed = vi.fn();
    window.addEventListener("mivlet:mcp-app-panel-ready", ready);
    window.addEventListener("mivlet:mcp-app-panel-closed", closed);
    const first: RightPanelTab = {
      id: "app:first",
      kind: "mcp-app",
      title: "First tool",
    };
    const second: RightPanelTab = {
      id: "app:second",
      kind: "mcp-app",
      title: "Second tool",
    };
    const props = {
      ...base(),
      renderTab: (tab: RightPanelTab) => (
        <div data-mcp-app-panel={tab.id}>{tab.title}</div>
      ),
    };
    const view = render(<WorkspaceRightNav {...props} request={first} />);
    expect(ready.mock.calls.at(-1)?.[0].detail).toMatchObject({
      id: first.id,
      target: expect.any(HTMLElement),
    });
    view.rerender(<WorkspaceRightNav {...props} request={second} />);
    expect(closed.mock.calls.at(-1)?.[0].detail.id).toBe(first.id);
    expect(screen.getByText("Second tool", { selector: "div" })).toBeVisible();
    expect(ready.mock.calls.at(-1)?.[0].detail.id).toBe(second.id);
    view.rerender(
      <WorkspaceRightNav {...props} request={second} open={false} />,
    );
    expect(closed).toHaveBeenCalledTimes(1);
    view.rerender(<WorkspaceRightNav {...props} request={second} />);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(closed.mock.calls.at(-1)?.[0].detail.id).toBe(second.id);
    expect(screen.getByRole("tab", { name: "Activity" })).toBeVisible();
    view.unmount();
    window.removeEventListener("mivlet:mcp-app-panel-ready", ready);
    window.removeEventListener("mivlet:mcp-app-panel-closed", closed);
  });
  it("starts with the five direct rail tabs without the former utility menu", () => {
    render(
      <WorkspaceRightNav {...base()} activity={() => <p>Current work</p>} />,
    );
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Activity",
      "Files",
      "Memory",
      "Side Chat",
      "Schedules",
    ]);
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Current work")).toBeVisible();
    for (const name of ["Browser", "More workspace options"])
      expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("mounts collections only on first visit, preserving a Files search across inspection", () => {
    const mounted = vi.fn();
    function Files() {
      mounted();
      return <input aria-label="Search files" />;
    }
    const props = {
      ...base(),
      library: <Files />,
      renderTab: () => <p>Document contents</p>,
    };
    const view = render(<WorkspaceRightNav {...props} />);
    expect(mounted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "launch" },
    });
    view.rerender(<WorkspaceRightNav {...props} request={request} />);
    expect(screen.getByText("Document contents")).toBeVisible();
    expect(screen.getByRole("tablist")).toBeVisible();
    expect(screen.getAllByRole("tab")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("textbox")).toHaveValue("launch");
    expect(screen.getByRole("tab", { name: "Files" })).toHaveFocus();
  });

  it("keeps only one inspector and does not grow a document tab strip", () => {
    const props = {
      ...base(),
      renderTab: (tab: RightPanelTab) => <p>{tab.title} content</p>,
    };
    const view = render(<WorkspaceRightNav {...props} request={request} />);
    view.rerender(
      <WorkspaceRightNav
        {...props}
        request={{ ...request, id: "second", title: "Second" }}
      />,
    );
    expect(screen.queryByText("Launch brief content")).toBeNull();
    expect(screen.getByText("Second content")).toBeVisible();
    expect(screen.getByRole("tablist")).toBeVisible();
    expect(screen.getAllByRole("tab")).toHaveLength(5);
  });

  it("never reopens a stale request on chat or scope changes", () => {
    const props = {
      ...base(),
      request,
      renderTab: () => <p>Previous document</p>,
    };
    const view = render(<WorkspaceRightNav {...props} />);
    expect(screen.getByText("Previous document")).toBeVisible();
    view.rerender(
      <WorkspaceRightNav {...props} identity="workspace:other-chat" />,
    );
    expect(screen.queryByText("Previous document")).toBeNull();
    const nextRequest = { ...request };
    view.rerender(
      <WorkspaceRightNav
        {...props}
        request={nextRequest}
        identity="workspace:other-chat"
        scope="owner"
      />,
    );
    expect(screen.getByText("Previous document")).toBeVisible();
    view.rerender(
      <WorkspaceRightNav
        {...props}
        request={nextRequest}
        identity="workspace:other-chat"
        scope="chat"
      />,
    );
    expect(screen.queryByText("Previous document")).toBeNull();
  });

  it("switches sections with arrow keys and Home/End", () => {
    render(
      <WorkspaceRightNav {...base()} schedules={<p>Saved schedules</p>} />,
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: "Activity" }), {
      key: "ArrowRight",
    });
    expect(screen.getByRole("tab", { name: "Files" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Files" }), {
      key: "End",
    });
    expect(screen.getByText("Saved schedules")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Schedules" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Schedules" }), {
      key: "Home",
    });
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveFocus();
  });

  it("keeps Side Chat and Schedules reachable as direct rail tabs", () => {
    render(
      <WorkspaceRightNav
        {...base()}
        schedules={<p>Manage routines</p>}
        sideChats={<p>Saved conversations</p>}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Schedules" }));
    expect(screen.getByText("Manage routines")).toBeVisible();
    const selectedTab = screen.getByRole("tab", { name: "Schedules" });
    expect(
      document.getElementById(selectedTab.getAttribute("aria-controls")!),
    ).toBeVisible();
    expect(screen.getByRole("tab", { name: "Schedules" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Side Chat" }));
    expect(screen.getByText("Saved conversations")).toBeVisible();
    expect(screen.queryByText("Manage routines")).not.toBeVisible();
  });

  it("opens requested work details while retaining the section navigation", () => {
    render(
      <WorkspaceRightNav
        {...base()}
        historyRequestId="work"
        history={<p>Selected assignment</p>}
      />,
    );
    expect(screen.getByText("Selected assignment")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Back to Activity" }));
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveFocus();
  });

  it("releases chat focus when returning from an inspected conversation", () => {
    const props = base();
    render(
      <WorkspaceRightNav
        {...props}
        request={{
          id: "chat:ideas",
          kind: "chat",
          roomId: "ideas",
          title: "Ideas",
        }}
        renderTab={() => <p>Side conversation</p>}
      />,
    );
    expect(props.onChatActiveChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(props.onChatActiveChange).toHaveBeenLastCalledWith(false);
  });

  it("closes from the header X while preserving the rail", () => {
    const props = {
      ...base(),
      request,
      renderTab: () => <p>Saved document</p>,
    };
    const view = render(<WorkspaceRightNav {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Close workspace panel" }));
    expect(props.onClose).toHaveBeenCalledOnce();
    view.rerender(<WorkspaceRightNav {...props} open={false} />);
    expect(screen.getByText("Saved document")).not.toBeVisible();
    expect(screen.getByRole("tablist")).toBeVisible();
    expect(screen.getAllByRole("tab")).toHaveLength(5);
  });

  it("opens a collapsed collection from the rail and keeps the selected page open on repeat clicks", () => {
    const props = {
      ...base(),
      library: <input aria-label="Retained file search" />,
    };
    const view = render(<WorkspaceRightNav {...props} open={false} />);
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(props.onOpen).toHaveBeenCalledOnce();
    view.rerender(<WorkspaceRightNav {...props} />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "brief" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onOpen).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("textbox")).toHaveValue("brief");
  });

  it("uses vertical arrow navigation and leaves the rail reachable while inspecting", () => {
    const props = { ...base(), renderTab: () => <p>Inspected file</p> };
    const view = render(<WorkspaceRightNav {...props} />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Activity" }), {
      key: "ArrowDown",
    });
    expect(screen.getByRole("tab", { name: "Files" })).toHaveFocus();
    view.rerender(<WorkspaceRightNav {...props} request={request} />);
    fireEvent.click(screen.getByRole("tab", { name: "Memory" }));
    expect(screen.queryByText("Inspected file")).toBeNull();
    expect(screen.getByRole("tab", { name: "Memory" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("traps narrow-screen focus, closes with Escape and restores the opener", () => {
    media.compact = true;
    const props = base();
    const view = render(
      <>
        <button>Open panel</button>
        <WorkspaceRightNav {...props} open={false} />
      </>,
    );
    screen.getByRole("button", { name: "Open panel" }).focus();
    view.rerender(
      <>
        <button>Open panel</button>
        <WorkspaceRightNav {...props} />
      </>,
    );
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledOnce();
    view.rerender(
      <>
        <button>Open panel</button>
        <WorkspaceRightNav {...props} open={false} />
      </>,
    );
    expect(screen.getByRole("button", { name: "Open panel" })).toHaveFocus();
  });
});

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
  onClose: vi.fn(),
  onCloseComputer: vi.fn(),
  onChatActiveChange: vi.fn(),
});
beforeEach(() => {
  media.compact = false;
});

describe("contextual workspace panel", () => {
  it("starts with Activity, Files and Memory without the former utility menu", () => {
    render(
      <WorkspaceRightNav {...base()} activity={() => <p>Current work</p>} />,
    );
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Activity",
      "Files",
      "Memory",
    ]);
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Current work")).toBeVisible();
    for (const name of ["Browser", "Side chat", "Schedules"])
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
    expect(screen.queryByRole("tablist")).toBeNull();
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
    expect(screen.queryByRole("tablist")).toBeNull();
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
      <WorkspaceRightNav {...base()} memories={<p>Saved preferences</p>} />,
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: "Activity" }), {
      key: "ArrowRight",
    });
    expect(screen.getByRole("tab", { name: "Files" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Files" }), {
      key: "End",
    });
    expect(screen.getByText("Saved preferences")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Memory" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Memory" }), {
      key: "Home",
    });
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveFocus();
  });

  it("browses the owning project only after an explicit scope selection", () => {
    const change = vi.fn();
    render(
      <WorkspaceRightNav
        {...base()}
        ownerLabel="Portfolio"
        onScopeChange={change}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Panel scope" })).toHaveValue(
      "chat",
    );
    expect(change).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "owner" },
    });
    expect(change).toHaveBeenCalledWith("owner");
  });

  it("keeps secondary schedules and conversations reachable through More", () => {
    render(
      <WorkspaceRightNav
        {...base()}
        schedules={<p>Manage routines</p>}
        sideChats={<p>Saved conversations</p>}
      />,
    );
    fireEvent.click(screen.getByLabelText("More workspace options"));
    fireEvent.click(screen.getByRole("button", { name: "Schedules" }));
    expect(screen.getByText("Manage routines")).toBeVisible();
    const selectedTab = screen.getByRole("tab", { name: "Activity" });
    expect(
      document.getElementById(selectedTab.getAttribute("aria-controls")!),
    ).toBeVisible();
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.click(screen.getByLabelText("More workspace options"));
    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
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

  it("hides the entire panel without cancelling or losing its inspected content", () => {
    const props = {
      ...base(),
      request,
      renderTab: () => <p>Saved document</p>,
    };
    const view = render(<WorkspaceRightNav {...props} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Close workspace panel" }),
    );
    expect(props.onClose).toHaveBeenCalledOnce();
    view.rerender(<WorkspaceRightNav {...props} open={false} />);
    expect(screen.getByText("Saved document")).not.toBeVisible();
    view.rerender(<WorkspaceRightNav {...props} />);
    expect(screen.getByText("Saved document")).toBeVisible();
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

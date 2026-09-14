import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ConversationGrid,
  ConversationTabs,
  PaneDivider,
} from "./ConversationTabs";
import {
  emptyLayout,
  reduceLayout,
  type LayoutAction,
} from "../../lib/conversation-layout";
import { useConversationDrag } from "../../hooks/useConversationDrag";
const layout = ["a", "b"].reduce(
  (current, id) =>
    reduceLayout(current, {
      type: "open",
      view: { id, kind: "conversation", conversationId: `room-${id}` },
    }),
  emptyLayout(),
);
function Harness({
  onAction,
  onOpen,
}: {
  onAction: (action: LayoutAction) => void;
  onOpen: (id: string, newTab: boolean) => void;
}) {
  const onPointerDown = useConversationDrag(layout, onAction, onOpen, true);
  return (
    <main onPointerDownCapture={onPointerDown}>
      <button data-conversation-room="room-c">History item</button>
      <ConversationTabs
        layout={layout}
        titles={{ "room-a": "First", "room-b": "Second" }}
        indicators={{}}
        onAction={onAction}
        onCreate={() => {}}
      />
      <ConversationGrid
        layout={layout}
        compact={false}
        onAction={onAction}
        renderPane={() => <p>Conversation</p>}
      />
    </main>
  );
}
function pointer(element: Element, type: string, x: number, y: number) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: x,
    clientY: y,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(element, event);
}
function capture(element: Element) {
  const target = element as HTMLElement;
  target.setPointerCapture = vi.fn();
  target.hasPointerCapture = vi.fn(() => true);
  target.releasePointerCapture = vi.fn();
}
function pointTo(element: Element) {
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn(() => element),
  });
}
describe("workspace tab interactions", () => {
  it("searches overflow by project context and supports keyboard selection and dismissal", () => {
    const onAction = vi.fn();
    render(<ConversationTabs layout={layout} titles={{ "room-a": "Conversation with Mira", "room-b": "Conversation with Mira" }} descriptions={{ "room-a": "Website · Mira", "room-b": "Launch · Mira" }} indicators={{}} onAction={onAction} onCreate={() => {}} />);
    expect(screen.getByRole("tab", { name: "Mira · 1" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Mira · 2" })).toBeVisible();
    const trigger = screen.getByRole("button", { name: "Search open tabs" });
    fireEvent.click(trigger);
    const search = screen.getByRole("searchbox", { name: "Search open tabs" });
    expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: "ArrowUp" });
    expect(screen.getByRole("button", { name: "Conversation with Mira Launch · Mira" })).toHaveFocus();
    fireEvent.change(search, { target: { value: "website" } });
    expect(screen.queryByRole("button", { name: "Conversation with Mira Launch · Mira" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Conversation with Mira Website · Mira" }));
    expect(onAction).toHaveBeenCalledWith({ type: "activate", id: "a" });
    expect(screen.queryByRole("dialog", { name: "Open tabs" })).toBeNull();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("dialog", { name: "Open tabs" })).toBeNull();
  });
  it("reveals the active tab again after the window is resized", () => {
    render(<ConversationTabs layout={layout} titles={{ "room-a": "First", "room-b": "Second" }} indicators={{}} onAction={() => {}} onCreate={() => {}} />);
    const active = screen.getByRole("tab", { selected: true });
    active.scrollIntoView = vi.fn();
    fireEvent(window, new Event("resize"));
    expect(active.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });
  it("opens history in a new tab after a pointer drag and preserves normal tab keyboard controls", () => {
    const onOpen = vi.fn(),
      onAction = vi.fn();
    render(<Harness onOpen={onOpen} onAction={onAction} />);
    const source = screen.getByRole("button", { name: "History item" });
    capture(source);
    pointTo(screen.getByRole("tablist"));
    pointer(source, "pointerdown", 300, 200);
    pointer(source, "pointermove", 100, 20);
    pointer(source, "pointerup", 100, 20);
    expect(onOpen).toHaveBeenCalledWith("room-c", true);
    fireEvent.keyDown(screen.getByRole("tab", { name: "First" }), {
      key: "Delete",
    });
    expect(onAction).toHaveBeenCalledWith({ type: "close", id: "a" });
  });
  it("docks at the final pointer position without depending on browser file-drop events", () => {
    const onAction = vi.fn();
    const result = render(<Harness onOpen={() => {}} onAction={onAction} />);
    const source = result.container.querySelector(
      '[data-conversation-view="b"]',
    )!;
    capture(source);
    const target = result.container.querySelector(
      '[data-conversation-pane="0"]',
    )!;
    pointTo(target);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 50,
      width: 800,
      height: 600,
    } as DOMRect);
    pointer(source, "pointerdown", 200, 20);
    pointer(source, "pointermove", 780, 300);
    expect(
      document.querySelector(".conversation-dock__hint"),
    ).toHaveTextContent("Split here");
    pointer(source, "pointerup", 400, 640);
    expect(onAction).toHaveBeenCalledWith({
      type: "dock",
      id: "b",
      pane: 0,
      edge: "bottom",
    });
    expect(document.querySelector(".conversation-dock__hint")).toBeNull();
  });
  it("does not turn clicks into drags and cancels a drag with Escape", () => {
    const onAction = vi.fn(),
      onOpen = vi.fn();
    render(<Harness onOpen={onOpen} onAction={onAction} />);
    const source = screen.getByRole("button", { name: "History item" });
    capture(source);
    pointTo(screen.getByRole("tablist"));
    pointer(source, "pointerdown", 300, 200);
    pointer(source, "pointerup", 300, 200);
    expect(onOpen).not.toHaveBeenCalled();
    pointer(source, "pointerdown", 300, 200);
    pointer(source, "pointermove", 100, 20);
    fireEvent.keyDown(document, { key: "Escape" });
    pointer(source, "pointerup", 100, 20);
    expect(onOpen).not.toHaveBeenCalled();
  });
  it.each(["row", "column"] as const)(
    "measures the nearest %s split and supports keyboard sizing",
    (axis) => {
      const onResize = vi.fn();
      const result = render(
        <div className="conversation-grid-split">
          <div style={{ display: "contents" }}>
            <PaneDivider axis={axis} ratio={0.5} onResize={onResize} />
          </div>
        </div>,
      );
      vi.spyOn(
        result.container.firstElementChild!,
        "getBoundingClientRect",
      ).mockReturnValue({
        left: 200,
        top: 100,
        width: 1000,
        height: 500,
      } as DOMRect);
      const divider = screen.getByRole("separator");
      divider.hasPointerCapture = vi.fn(() => true);
      fireEvent(
        divider,
        new MouseEvent("pointermove", {
          bubbles: true,
          clientX: 600,
          clientY: 300,
        }),
      );
      expect(onResize).toHaveBeenLastCalledWith(0.4);
      fireEvent.keyDown(divider, {
        key: axis === "row" ? "ArrowRight" : "ArrowDown",
      });
      expect(onResize).toHaveBeenLastCalledWith(0.525);
      fireEvent.keyDown(divider, { key: "Home" });
      expect(onResize).toHaveBeenLastCalledWith(0.2);
    },
  );
  it("offers contextual creation targets and dismisses the menu on Escape", async () => {
    const sideChat = vi.fn();
    const createAgent = vi.fn();
    // Settle any deferred drag-gesture teardown from earlier tests before
    // interacting; a leaked click suppressor must never swallow this menu.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const view = render(
      <ConversationTabs
        layout={layout}
        titles={{ "room-a": "First", "room-b": "Second" }}
        indicators={{}}
        onAction={vi.fn()}
        onCreate={() => {}}
        newActions={[
          { id: "side-chat", label: "New side chat with Mira", run: sideChat },
          { id: "agent", label: "New agent", run: createAgent },
        ]}
      />,
    );
    const scope = within(view.container);
    // The legacy generic Plus is replaced by the named menu.
    expect(scope.queryByRole("button", { name: "New conversation" })).toBeNull();
    fireEvent.click(scope.getByRole("button", { name: "New" }));
    expect(scope.getByRole("menuitem", { name: "New side chat with Mira" })).toHaveFocus();
    fireEvent.keyDown(scope.getByRole("menuitem", { name: "New side chat with Mira" }), { key: "ArrowDown" });
    const item = scope.getByRole("menuitem", { name: "New side chat with Mira" });
    expect(scope.getByRole("menuitem", { name: "New agent" })).toBeVisible();
    fireEvent.click(item);
    expect(sideChat).toHaveBeenCalledOnce();
    expect(createAgent).not.toHaveBeenCalled();
    expect(scope.queryByRole("menu", { name: "Create" })).toBeNull();
    sideChat.mockClear();
    fireEvent.click(scope.getByRole("button", { name: "New" }));
    fireEvent.keyDown(scope.getByRole("menuitem", { name: "New side chat with Mira" }), { key: "ArrowDown" });
    expect(scope.getByRole("menuitem", { name: "New agent" })).toHaveFocus();
    fireEvent.keyDown(scope.getByRole("menuitem", { name: "New agent" }), { key: "Escape" });
    expect(scope.getByRole("button", { name: "New" })).toHaveFocus();
    expect(scope.queryByRole("menu", { name: "Create" })).toBeNull();
    expect(sideChat).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ConversationGrid,
  PaneDivider,
} from "./ConversationGrid";
import {
  emptyLayout,
  reduceLayout,
  type LayoutAction,
} from "../../lib/conversation-layout";
import { useConversationDrag } from "../../hooks/useConversationDrag";
const layout = ["a", "b"].reduce(
  (current, id) =>
    reduceLayout(current, {
      type: "navigate",
      view: { id, kind: "conversation", conversationId: `room-${id}` },
    }),
  emptyLayout(),
);
function Harness({
  onAction,
}: {
  onAction: (action: LayoutAction) => void;
}) {
  const onPointerDown = useConversationDrag(layout, onAction, true);
  return (
    <main onPointerDownCapture={onPointerDown}>
      <button data-conversation-room="room-c">History item</button>
      <button data-conversation-room="room-b">Other conversation</button>
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
describe("conversation pane interactions", () => {
  it("docks at the final pointer position without depending on browser file-drop events", () => {
    const onAction = vi.fn();
    const result = render(<Harness onAction={onAction} />);
    const source = result.container.querySelector(
      '[data-conversation-room="room-b"]',
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
      view: expect.objectContaining({ conversationId: "room-b" }),
      pane: 0,
      edge: "bottom",
    });
    expect(document.querySelector(".conversation-dock__hint")).toBeNull();
  });
  it("does not turn clicks into drags and cancels a drag with Escape", () => {
    const onAction = vi.fn();
    render(<Harness onAction={onAction} />);
    const source = screen.getByRole("button", { name: "History item" });
    capture(source);
    pointTo(document.querySelector("[data-conversation-pane]")!);
    pointer(source, "pointerdown", 300, 200);
    pointer(source, "pointerup", 300, 200);
    expect(onAction).not.toHaveBeenCalled();
    pointer(source, "pointerdown", 300, 200);
    pointer(source, "pointermove", 100, 20);
    fireEvent.keyDown(document, { key: "Escape" });
    pointer(source, "pointerup", 100, 20);
    expect(onAction).not.toHaveBeenCalled();
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
});

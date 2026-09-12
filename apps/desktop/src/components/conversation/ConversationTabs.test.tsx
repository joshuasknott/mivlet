import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PaneDivider } from "./ConversationTabs";

describe("conversation pane divider", () => {
  it("measures the pane grid through a boxless wrapper and preserves keyboard sizing", () => {
    const onResize = vi.fn();
    const view = render(
      <div className="conversation-panes">
        <div style={{ display: "contents" }}>
          <PaneDivider ratio={0.5} onResize={onResize} />
        </div>
      </div>,
    );
    const grid = view.container.firstElementChild!;
    vi.spyOn(grid, "getBoundingClientRect").mockReturnValue({
      left: 200,
      width: 1000,
    } as DOMRect);
    const divider = screen.getByRole("separator", {
      name: "Resize conversation panes",
    });
    divider.hasPointerCapture = vi.fn(() => true);
    fireEvent(
      divider,
      new MouseEvent("pointermove", {
        bubbles: true,
        clientX: 600,
      }),
    );
    expect(onResize).toHaveBeenLastCalledWith(0.4);
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(onResize).toHaveBeenLastCalledWith(0.525);
    fireEvent.keyDown(divider, { key: "Home" });
    expect(onResize).toHaveBeenLastCalledWith(0.25);
  });
});

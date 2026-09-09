import "@testing-library/jest-dom/vitest";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentAvatar } from "./agent-icons";

afterEach(() => vi.useRealTimers());
describe("agent expressions", () => {
  it("maps a saturated shell to the selected colour without darkening neutral highlights", () => {
    const view = render(<AgentAvatar seed="robot-v3:1:saved" color="#FF994D" />);
    const tables = [...view.container.querySelectorAll("feComponentTransfer > *")].map((node) => node.getAttribute("tableValues")!.split(" ").map(Number));
    for (const table of tables) {
      expect(table[0]).toBe(0);
      expect(table[2]).toBe(.1);
      expect(table[20]).toBe(1);
      expect(table.every((value) => value >= 0 && value <= 1)).toBe(true);
    }
    // Blue's midtone maps close to the orange preset, not a muddy brown.
    expect(tables[0][9]).toBeGreaterThan(.9);
    expect(tables[1][9]).toBeGreaterThan(.5);
    expect(tables[2][9]).toBeLessThan(.4);
  });
  it("keeps identity and colour across states while changing the face", () => {
    const view = render(<AgentAvatar seed="robot-v3:2:saved" color="#91ADD7" presence="idle" />);
    const source = view.container.querySelector("img")!.getAttribute("src");
    const tint = view.container.querySelector("feComponentTransfer")!.innerHTML;
    const rest = view.container.querySelector(".agent-avatar__eyes")!.innerHTML;
    view.rerender(<AgentAvatar seed="robot-v3:2:saved" color="#91ADD7" presence="waiting" />);
    expect(view.container.querySelector("img")).toHaveAttribute("src", source);
    expect(view.container.querySelector("feComponentTransfer")!.innerHTML).toBe(tint);
    expect(view.container.querySelector(".agent-avatar__eyes")!.innerHTML).not.toBe(rest);
  });
  it("leaves uploaded portraits unaltered, without synthetic eyes or colour filters", () => {
    const upload = "data:image/png;base64,example";
    const view = render(<AgentAvatar seed="robot-v3:1:saved" imageDataUrl={upload} color="#F00000" presence="working" motion="expressive" />);
    expect(view.container.querySelector("img")).toHaveAttribute("src", upload);
    expect(view.container.querySelector(".agent-avatar__face")).toBeNull();
    expect(view.container.querySelector("filter")).toBeNull();
  });
  it("celebrates a real transition once, settles, and does not replay restored completion", () => {
    vi.useFakeTimers();
    const view = render(<AgentAvatar seed="robot-v3:0:saved" presence="done" />);
    expect(view.container.firstChild).toHaveAttribute("data-expression", "idle");
    view.rerender(<AgentAvatar seed="robot-v3:0:saved" presence="working" />);
    view.rerender(<AgentAvatar seed="robot-v3:0:saved" presence="done" />);
    expect(view.container.firstChild).toHaveAttribute("data-expression", "done");
    act(() => vi.advanceTimersByTime(1200));
    expect(view.container.firstChild).toHaveAttribute("data-expression", "idle");
    expect(view.container.firstChild).toHaveAttribute("data-presence", "done");
  });
});

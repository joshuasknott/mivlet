import "@testing-library/jest-dom/vitest";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentAvatar } from "./agent-icons";

afterEach(() => vi.useRealTimers());
describe("agent expressions", () => {
  it("maps a saturated shell to the selected colour without darkening neutral highlights", () => {
    const view = render(<AgentAvatar seed="robot-v3:1:saved" color="#FF994D" />);
    const matrix = view.container.querySelector("feColorMatrix")!.getAttribute("values")!.split(" ").map(Number);
    const apply = (rgb: number[]) => [0, 1, 2].map((row) => rgb.reduce((sum, value, column) => sum + value * matrix[row * 5 + column], 0));
    const recoloured = apply([40 / 255, 121 / 255, 250 / 255]);
    [1, 153 / 255, 77 / 255].forEach((value, index) => expect(recoloured[index]).toBeCloseTo(value));
    apply([.04, .04, .04]).forEach((value) => expect(value).toBeCloseTo(.04));
    apply([1, 1, 1]).forEach((value) => expect(value).toBeCloseTo(1));
  });
  it("keeps identity and colour across states while changing the face", () => {
    const view = render(<AgentAvatar seed="robot-v3:2:saved" color="#91ADD7" presence="idle" />);
    const source = view.container.querySelector("img")!.getAttribute("src");
    const tint = view.container.querySelector("feColorMatrix")!.getAttribute("values");
    const rest = view.container.querySelector(".agent-avatar__eyes")!.innerHTML;
    view.rerender(<AgentAvatar seed="robot-v3:2:saved" color="#91ADD7" presence="waiting" />);
    expect(view.container.querySelector("img")).toHaveAttribute("src", source);
    expect(view.container.querySelector("feColorMatrix")).toHaveAttribute("values", tint);
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

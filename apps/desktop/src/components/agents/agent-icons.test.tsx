import "@testing-library/jest-dom/vitest";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MivletAgentProfile } from "@mivlet/protocol";
import { AgentAvatar, ProfileAgentAvatar } from "./agent-icons";
import { AVATAR_SHAPES } from "../../lib/blob-avatar";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const seed = "ink-v1:0:saved";
describe("ink agent characters", () => {
  it("renders all six artwork cells without stretching or sharing the selected cell", () => {
    const view = render(<>{AVATAR_SHAPES.map((_, index) => <AgentAvatar key={index} seed={`ink-v1:${index}:saved`} />)}</>);
    const characters = [...view.container.querySelectorAll(".ink-character__artwork image")];
    expect(characters).toHaveLength(6);
    expect(new Set(characters.map((character) => `${character.getAttribute("x")}:${character.getAttribute("y")}`)).size).toBe(6);
    for (const character of characters) {
      expect(character.getAttribute("href")).toContain("agent-characters.webp");
      expect(character).toHaveAttribute("width", "1536");
      expect(character).toHaveAttribute("height", "1024");
      expect(character.closest("svg")).toHaveAttribute("viewBox", "0 0 512 512");
    }
  });

  it("recolours only the body, preserving pupils, white faces and transparency", () => {
    const view = render(<AgentAvatar seed={seed} color="#3659E3" />);
    const artwork = view.container.querySelector(".ink-character__artwork image")!;
    const position = [artwork.getAttribute("x"), artwork.getAttribute("y")];
    const values = () => view.container.querySelector("feColorMatrix")!.getAttribute("values")!.split(" ").map(Number);
    const matrix = values();
    for (let row = 0; row < 3; row++) {
      expect(matrix[row * 5 + 4]).toBe(0); // Black stays black.
      expect(matrix.slice(row * 5, row * 5 + 3).reduce((a, b) => a + b)).toBeCloseTo(1); // White stays white.
      expect(matrix[row * 5] + matrix[row * 5 + 2]).toBeCloseTo([54, 89, 227][row] / 255);
    }
    expect(matrix.slice(15)).toEqual([0, 0, 0, 1, 0]); // Alpha is unchanged.
    expect((view.container.firstChild as HTMLElement).style.backgroundColor).toBe("");
    view.rerender(<AgentAvatar seed={seed} color="#E4684B" presence="waiting" />);
    expect(values()).not.toEqual(matrix);
    expect([artwork.getAttribute("x"), artwork.getAttribute("y")]).toEqual(position);
  });

  it("leaves uploaded portraits unaltered without generated motion or a colour background", () => {
    const upload = "data:image/png;base64,example";
    const view = render(<AgentAvatar seed={seed} imageDataUrl={upload} color="#F00000" presence="working" motion="expressive" />);
    expect(view.container.querySelector("img")).toHaveAttribute("src", upload);
    expect(view.container.querySelector(".ink-character__head")).toBeNull();
    expect(view.container.firstChild).toHaveAttribute("data-animate", "false");
    expect((view.container.firstChild as HTMLElement).style.backgroundColor).toBe("");
  });

  it("uses safe defaults for malformed custom colours", () => {
    const view = render(<AgentAvatar seed={seed} color="url(https://example.com)" />);
    expect(view.container.querySelector("feColorMatrix")).not.toHaveAttribute("values", expect.stringContaining("NaN"));
  });

  it("acknowledges completion once, settles, and never replays an already completed mount", () => {
    vi.useFakeTimers();
    const view = render(<AgentAvatar seed={seed} presence="done" motion="expressive" />);
    expect(view.container.firstChild).toHaveAttribute("data-expression", "idle");
    view.rerender(<AgentAvatar seed={seed} presence="working" motion="expressive" />);
    view.rerender(<AgentAvatar seed={seed} presence="done" motion="expressive" />);
    expect(view.container.firstChild).toHaveAttribute("data-expression", "done");
    act(() => vi.advanceTimersByTime(901));
    expect(view.container.firstChild).toHaveAttribute("data-expression", "idle");
    view.rerender(<AgentAvatar seed={seed} presence="done" color="#79E5C2" motion="expressive" />);
    expect(view.container.firstChild).toHaveAttribute("data-expression", "idle");
    expect(view.container.firstChild).toHaveAttribute("data-presence", "done");
  });

  it.each(["paused", "human", "waiting", "blocked"] as const)("immediately replaces completion with %s and cancels the acknowledgement timer", (presence) => {
    vi.useFakeTimers();
    const view = render(<AgentAvatar seed={seed} presence="working" motion="expressive" />);
    view.rerender(<AgentAvatar seed={seed} presence="done" motion="expressive" />);
    expect(vi.getTimerCount()).toBe(1);
    view.rerender(<AgentAvatar seed={seed} presence={presence} motion="expressive" />);
    expect(view.container.firstChild).toHaveAttribute("data-expression", presence);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not inherit completion across conversation or attempt scope changes", () => {
    const view = render(<AgentAvatar seed={seed} activityKey="thread-a:attempt-a" presence="working" motion="expressive" />);
    view.rerender(<AgentAvatar seed={seed} activityKey="thread-b:old-attempt" presence="done" motion="expressive" />);
    expect(view.container.firstChild).toHaveAttribute("data-expression", "idle");
    view.rerender(<AgentAvatar seed={seed} activityKey="thread-b:old-attempt" presence="working" motion="expressive" />);
    view.rerender(<AgentAvatar seed={seed} activityKey="thread-b:new-attempt" presence="done" motion="expressive" />);
    expect(view.container.firstChild).toHaveAttribute("data-expression", "idle");
  });

  it("fences agents even when both profiles use the same saved seed", () => {
    const profile = { id: "a", avatarSeed: seed } as MivletAgentProfile;
    const view = render(<ProfileAgentAvatar agent={profile} presence="working" motion="expressive" />);
    view.rerender(<ProfileAgentAvatar agent={{ ...profile, id: "b" }} presence="done" motion="expressive" />);
    expect(view.container.firstChild).toHaveAttribute("data-expression", "idle");
  });

  it("does not subscribe static picker icons to visibility observers", () => {
    const observer = vi.fn();
    vi.stubGlobal("IntersectionObserver", observer);
    const listen = vi.spyOn(document, "addEventListener");
    const view = render(<AgentAvatar seed={seed} motion="quiet" />);
    expect(observer).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(view.container.firstChild).toHaveAttribute("data-animate", "false");
  });

  it("suspends hidden/offscreen timelines and consumes hidden completions without replay on return", () => {
    vi.useFakeTimers();
    let intersect: (entries: { isIntersecting: boolean }[]) => void = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: typeof intersect) { intersect = callback; }
      observe() {}
      disconnect = disconnect;
    });
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("visible");
    const view = render(<AgentAvatar seed={seed} presence="working" motion="expressive" />);
    expect(view.container.firstChild).toHaveAttribute("data-animate", "false");
    act(() => intersect([{ isIntersecting: true }]));
    expect(view.container.firstChild).toHaveAttribute("data-animate", "true");
    act(() => { visibility.mockReturnValue("hidden"); document.dispatchEvent(new Event("visibilitychange")); });
    expect(view.container.firstChild).toHaveAttribute("data-animate", "false");
    view.rerender(<AgentAvatar seed={seed} presence="done" motion="expressive" />);
    expect(vi.getTimerCount()).toBe(0);
    act(() => { visibility.mockReturnValue("visible"); document.dispatchEvent(new Event("visibilitychange")); });
    expect(view.container.firstChild).toHaveAttribute("data-expression", "idle");
    act(() => intersect([{ isIntersecting: false }]));
    expect(view.container.firstChild).toHaveAttribute("data-animate", "false");
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});

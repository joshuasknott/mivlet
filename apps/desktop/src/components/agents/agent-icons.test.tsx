import "@testing-library/jest-dom/vitest";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MivletAgentProfile } from "@mivlet/protocol";
import { AgentAvatar, ProfileAgentAvatar } from "./agent-icons";
import { AVATAR_COLOURS } from "../../lib/blob-avatar";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const seed = "robot-v3:0:saved";
describe("vector agent characters", () => {
  it("renders all eight distinct silhouettes with independent vector parts and no raster or filter", () => {
    const view = render(<>{AVATAR_COLOURS.map((_, index) => <AgentAvatar key={index} seed={`robot-v3:${index}:saved`} />)}</>);
    const characters = [...view.container.querySelectorAll(".agent-avatar__svg")];
    expect(characters).toHaveLength(8);
    expect(view.container.querySelector("img, image, foreignObject, filter")).toBeNull();
    const silhouettes = characters.map((character) => {
      expect(character.querySelector(".agent-avatar__head")).not.toBeNull();
      expect(character.querySelector(".agent-avatar__accessory")).not.toBeNull();
      expect(character.querySelectorAll(".agent-avatar__eye")).toHaveLength(2);
      return character.querySelector("path.agent-avatar__shell")?.getAttribute("d");
    });
    expect(new Set(silhouettes).size).toBe(8);
    const ids = [...view.container.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const element of view.container.querySelectorAll("[fill^='url(']")) {
      expect(ids).toContain(element.getAttribute("fill")!.slice(5, -1));
    }
  });

  it("changes the shell colour directly while retaining identity and neutral display through expressions", () => {
    const view = render(<AgentAvatar seed={seed} color="#91ADD7" presence="idle" />);
    const shell = view.container.querySelector("path.agent-avatar__shell")!.getAttribute("d");
    const screen = view.container.querySelector(".agent-avatar__screen")!.outerHTML;
    const eyes = view.container.querySelector(".agent-avatar__eyes")!.innerHTML;
    view.rerender(<AgentAvatar seed={seed} color="#FF994D" presence="waiting" />);
    expect(view.container.querySelector('stop[stop-color="#FF994D"]')).not.toBeNull();
    expect(view.container.querySelector("path.agent-avatar__shell")).toHaveAttribute("d", shell);
    expect(view.container.querySelector(".agent-avatar__screen")!.outerHTML).toBe(screen);
    expect(view.container.querySelector(".agent-avatar__eyes")!.innerHTML).not.toBe(eyes);
  });

  it("leaves uploaded portraits unaltered and never attaches generated movement or expressions", () => {
    const upload = "data:image/png;base64,example";
    const view = render(<AgentAvatar seed={seed} imageDataUrl={upload} color="#F00000" presence="working" motion="expressive" />);
    expect(view.container.querySelector("img")).toHaveAttribute("src", upload);
    expect(view.container.querySelector("img")!.style.filter).toBe("");
    expect(view.container.querySelector("svg")).toBeNull();
    expect(view.container.firstChild).toHaveAttribute("data-animate", "false");
  });

  it("uses speaking geometry only for confirmed speaking presence", () => {
    const view = render(<AgentAvatar seed={seed} presence="working" />);
    expect(view.container.querySelector(".agent-avatar__mouth")).toBeNull();
    view.rerender(<AgentAvatar seed={seed} presence="speaking" />);
    expect(view.container.querySelector(".agent-avatar__mouth")).not.toBeNull();
    view.rerender(<AgentAvatar seed={seed} presence="paused" />);
    expect(view.container.querySelector(".agent-avatar__mouth")).toBeNull();
  });

  it("acknowledges completion once, settles, and never replays an already completed mount", () => {
    vi.useFakeTimers();
    const view = render(<AgentAvatar seed={seed} presence="done" />);
    expect(view.container.firstChild).toHaveAttribute("data-expression", "idle");
    view.rerender(<AgentAvatar seed={seed} presence="working" />);
    view.rerender(<AgentAvatar seed={seed} presence="done" />);
    expect(view.container.firstChild).toHaveAttribute("data-expression", "done");
    act(() => vi.advanceTimersByTime(901));
    expect(view.container.firstChild).toHaveAttribute("data-expression", "idle");
    view.rerender(<AgentAvatar seed={seed} presence="done" color="#79E5C2" />);
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
    const view = render(<AgentAvatar seed={seed} activityKey="thread-a:attempt-a" presence="working" />);
    view.rerender(<AgentAvatar seed={seed} activityKey="thread-b:old-attempt" presence="done" />);
    expect(view.container.firstChild).toHaveAttribute("data-expression", "idle");
    view.rerender(<AgentAvatar seed={seed} activityKey="thread-b:old-attempt" presence="working" />);
    view.rerender(<AgentAvatar seed={seed} activityKey="thread-b:new-attempt" presence="done" />);
    expect(view.container.firstChild).toHaveAttribute("data-expression", "idle");
  });

  it("fences agents even when both profiles use the same saved seed", () => {
    const profile = { id: "a", avatarSeed: seed } as MivletAgentProfile;
    const view = render(<ProfileAgentAvatar agent={profile} presence="working" />);
    view.rerender(<ProfileAgentAvatar agent={{ ...profile, id: "b" }} presence="done" />);
    expect(view.container.firstChild).toHaveAttribute("data-expression", "idle");
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

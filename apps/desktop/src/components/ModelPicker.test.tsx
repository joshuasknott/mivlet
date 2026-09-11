import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelPicker } from "./ModelPicker";
import type { ProviderModelOption } from "../lib/provider-models";
const models: ProviderModelOption[] = [
  { id: "codex::reasoner", modelId: "reasoner", providerId: "codex", providerLabel: "ChatGPT", label: "Reasoner", available: true, reasoning: { supportedEfforts: ["low", "high"], defaultEffort: "low" } },
  { id: "xai::other", modelId: "other", providerId: "xai", providerLabel: "xAI", label: "Other", available: true }
];
function Harness({ choose = () => undefined, options = models }: { choose?: (value: string | undefined) => void; options?: ProviderModelOption[] }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState(options[0]?.id ?? "");
  const [effort, setEffort] = useState<string>();
  return <><button>Outside</button><ModelPicker models={options} selectedId={id} label={options.find((model) => model.id === id)?.label ?? "Automatic"}
    effort={effort} onSelect={(value) => { setId(value); setEffort(undefined); }}
    onSelectEffort={(value) => { choose(value); setEffort(value); }} open={open} onOpenChange={setOpen} /></>;
}
const openPicker = () => fireEvent.click(screen.getByRole("button", { name: "Select model" }));
const browse = () => fireEvent.click(screen.getByRole("button", { name: "Change model" }));
describe("Model picker", () => {
  it("uses only supported effort steps, keeps adjustments open, and resets to the provider default", () => {
    const choose = vi.fn(); render(<Harness choose={choose} />); openPicker();
    const slider = screen.getByRole("slider", { name: "Reasoning effort" });
    expect(slider).toHaveFocus();
    expect(slider).toHaveAttribute("max", "1");
    expect(slider).toHaveAttribute("aria-valuetext", "Low");
    fireEvent.change(slider, { target: { value: "1" } });
    expect(choose).toHaveBeenLastCalledWith("high");
    expect(slider).toHaveAttribute("aria-valuetext", "High");
    fireEvent.click(screen.getByRole("button", { name: "Reset reasoning to default" }));
    expect(choose).toHaveBeenLastCalledWith(undefined);
    expect(slider).toHaveAttribute("aria-valuetext", "Low");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  it("filters multiple providers and searches without changing the selection", () => {
    render(<Harness />); openPicker(); browse();
    expect(screen.getByRole("searchbox")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "xAI" }));
    expect(screen.queryByRole("menuitemradio", { name: "ChatGPT Reasoner" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing" } });
    expect(screen.getByRole("status")).toHaveTextContent("No matching models");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Other" } });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "xAI Other" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    openPicker(); expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "xAI Other" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "ChatGPT Reasoner" }));
    expect(screen.getByRole("slider")).toHaveFocus();
  });
  it("supports keyboard navigation, Escape and outside dismissal", () => {
    render(<Harness />); openPicker(); browse();
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "ArrowDown" });
    expect(screen.getByRole("menuitemradio", { name: "ChatGPT Reasoner" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(screen.getByRole("menuitemradio", { name: "xAI Other" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Select model" })).toHaveFocus();
    openPicker(); fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("keeps duplicate model names provider-qualified and unavailable entries disabled", () => {
    render(<Harness options={[...models, { ...models[0], id: "xai::reasoner", providerId: "xai", providerLabel: "xAI", available: false }]} />);
    openPicker(); browse();
    expect(screen.getByRole("menuitemradio", { name: "xAI Reasoner, unavailable" })).toBeDisabled();
    expect(screen.getByRole("menuitemradio", { name: "ChatGPT Reasoner" })).toBeEnabled();
  });
  it("explains an empty catalogue without offering effort controls", () => {
    render(<Harness options={[]} />); openPicker();
    expect(screen.getByRole("status")).toHaveTextContent("Connect a provider");
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  });
});

describe("Model picker placement", () => {
  interface Box { left: number; top: number; right: number; bottom: number }
  const box = ({ left, top, right, bottom }: Box): DOMRect => ({ x: left, y: top, width: right - left, height: bottom - top, left, top, right, bottom, toJSON: () => ({}) }) as DOMRect;
  let restoreViewport: () => void = () => undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    restoreViewport();
  });

  // Wraps the picker in a mockable ".workspace" clipping ancestor. The
  // testing-library wrapper (document.body's direct child) must report a
  // full-viewport rect so only the workspace constrains the panel.
  function stubLayout(viewport: { width: number; height: number }, workspace: Box, anchor: Box) {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains("composer-control-anchor")) return box(anchor);
      if (this.classList.contains("workspace")) return box(workspace);
      if (this.parentElement === document.body) return box({ left: 0, top: 0, right: viewport.width, bottom: viewport.height });
      return box({ left: 0, top: 0, right: 0, bottom: 0 });
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: Element) {
      return this.classList.contains("model-picker") ? 320 : 0;
    });
    const descriptor = { configurable: true } as PropertyDescriptor;
    Object.defineProperty(window, "innerWidth", { ...descriptor, value: viewport.width });
    Object.defineProperty(window, "innerHeight", { ...descriptor, value: viewport.height });
    restoreViewport = () => {
      Object.defineProperty(window, "innerWidth", { ...descriptor, value: 1024 });
      Object.defineProperty(window, "innerHeight", { ...descriptor, value: 768 });
    };
  }
  function PlacementHarness({ options = models }: { options?: ProviderModelOption[] }) {
    const [open, setOpen] = useState(false);
    return <div className="workspace"><ModelPicker models={options} selectedId={options[0]?.id ?? ""} label="Example model"
      onSelect={() => undefined} open={open} onOpenChange={setOpen} /></div>;
  }
  const openPanel = () => { fireEvent.click(screen.getByRole("button", { name: "Select model" })); return screen.getByRole("dialog"); };

  it("clamps the panel inside the workspace when the trigger sits beside the left navigation", () => {
    stubLayout({ width: 1100, height: 800 }, { left: 204, top: 30, right: 1100, bottom: 800 }, { left: 327, top: 729, right: 492, bottom: 769 });
    render(<PlacementHarness />);
    const menu = openPanel();
    // The stylesheet would right-align the 320px panel to the trigger (left
    // edge 172), running 32px past the workspace edge at 204 and under the
    // navigation. Placement pulls it back to the 12px gutter instead.
    expect(menu.style.right).toBe("auto");
    expect(menu.style.left).toBe("-111px");
    expect(menu.style.maxHeight).toBe("400px");
  });

  it("clamps the panel to the viewport when the trigger sits at the right edge", () => {
    stubLayout({ width: 1280, height: 800 }, { left: 240, top: 30, right: 1280, bottom: 800 }, { left: 1194, top: 729, right: 1274, bottom: 769 });
    render(<PlacementHarness />);
    const menu = openPanel();
    expect(menu.style.left).toBe("-246px");
    expect(Number.parseInt(menu.style.left, 10) + 1194 + 320).toBeLessThanOrEqual(1280 - 12);
  });

  it("shrinks the panel when the container is narrower than the panel", () => {
    stubLayout({ width: 1100, height: 800 }, { left: 204, top: 30, right: 504, bottom: 800 }, { left: 230, top: 729, right: 310, bottom: 769 });
    render(<PlacementHarness />);
    const menu = openPanel();
    expect(menu.style.width).toBe("276px");
    expect(menu.style.left).toBe("-14px");
  });

  it("flips below the trigger and limits height when there is no room above", () => {
    stubLayout({ width: 1280, height: 800 }, { left: 0, top: 0, right: 1280, bottom: 800 }, { left: 100, top: 150, right: 420, bottom: 190 });
    render(<PlacementHarness />);
    const menu = openPanel();
    expect(menu.style.bottom).toBe("auto");
    expect(menu.style.top).toBe("calc(100% + 6px)");
    expect(menu.style.maxHeight).toBe("400px");
  });

  it("repositions on resize while open", () => {
    stubLayout({ width: 1100, height: 800 }, { left: 204, top: 30, right: 1100, bottom: 800 }, { left: 327, top: 729, right: 492, bottom: 769 });
    render(<PlacementHarness />);
    const menu = openPanel();
    expect(menu.style.left).toBe("-111px");
    stubLayout({ width: 1280, height: 800 }, { left: 240, top: 30, right: 1280, bottom: 800 }, { left: 1194, top: 729, right: 1274, bottom: 769 });
    fireEvent(window, new Event("resize"));
    expect(menu.style.left).toBe("-246px");
  });

  it("regrows the panel when a shrunken container widens", () => {
    stubLayout({ width: 1100, height: 800 }, { left: 204, top: 30, right: 504, bottom: 800 }, { left: 230, top: 729, right: 310, bottom: 769 });
    render(<PlacementHarness />);
    const menu = openPanel();
    expect(menu.style.width).toBe("276px");
    stubLayout({ width: 1280, height: 800 }, { left: 240, top: 30, right: 1280, bottom: 800 }, { left: 400, top: 729, right: 480, bottom: 769 });
    fireEvent(window, new Event("resize"));
    expect(menu.style.width).toBe("");
    expect(menu.style.left).toBe("-148px");
  });

  it("returns above the trigger once the space above recovers", () => {
    stubLayout({ width: 1280, height: 800 }, { left: 0, top: 0, right: 1280, bottom: 800 }, { left: 100, top: 150, right: 420, bottom: 190 });
    render(<PlacementHarness />);
    const menu = openPanel();
    expect(menu.style.top).toBe("calc(100% + 6px)");
    stubLayout({ width: 1280, height: 800 }, { left: 0, top: 0, right: 1280, bottom: 800 }, { left: 100, top: 729, right: 420, bottom: 769 });
    fireEvent(window, new Event("resize"));
    expect(menu.style.top).toBe("auto");
    expect(menu.style.bottom).toBe("");
  });

  it("repositions on scroll of a clipping ancestor while open", () => {
    stubLayout({ width: 1100, height: 800 }, { left: 204, top: 30, right: 1100, bottom: 800 }, { left: 327, top: 729, right: 492, bottom: 769 });
    render(<PlacementHarness />);
    const menu = openPanel();
    stubLayout({ width: 1100, height: 800 }, { left: 204, top: 30, right: 1100, bottom: 800 }, { left: 245, top: 729, right: 410, bottom: 769 });
    fireEvent(window, new Event("scroll"));
    expect(menu.style.left).toBe("-29px");
  });

  it("keeps stylesheet placement when no geometry is measurable", () => {
    render(<PlacementHarness />);
    const menu = openPanel();
    expect(menu.style.left).toBe("");
    expect(menu.style.maxHeight).toBe("");
  });

  it("releases inline placement when the responsive layout makes the anchor static", () => {
    stubLayout({ width: 1100, height: 800 }, { left: 204, top: 30, right: 1100, bottom: 800 }, { left: 230, top: 729, right: 310, bottom: 769 });
    render(<PlacementHarness />);
    const menu = openPanel();
    expect(menu.style.left).toBe("-14px");
    const original = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element, pseudo?: string | null) => (
      element.classList.contains("composer-control-anchor")
        ? { position: "static", overflow: "visible", overflowX: "visible", overflowY: "visible" } as CSSStyleDeclaration
        : original(element, pseudo)
    ));
    fireEvent(window, new Event("resize"));
    expect(menu.style.left).toBe("");
    expect(menu.style.width).toBe("");
    expect(menu.style.maxHeight).toBe("");
  });

  it("stays open for pointer presses inside the panel", () => {
    render(<Harness />);
    openPicker(); browse();
    fireEvent.pointerDown(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("renders long model names and large catalogues with selectable entries", () => {
    const longName = "Preview Reasoning Turbo Experimental Extended Context Edition for Enterprise Workspaces";
    const catalogue = Array.from({ length: 30 }, (_, index) => ({
      id: `codex::model-${index}`, modelId: `model-${index}`, providerId: "codex", providerLabel: "ChatGPT",
      label: index === 12 ? longName : `Model ${index}`, available: index !== 5,
      ...(index === 12 ? { reasoning: { supportedEfforts: ["low", "high"], defaultEffort: "low" } } : {})
    }));
    function ListHarness() {
      const [open, setOpen] = useState(false);
      const [id, setId] = useState(catalogue[0].id);
      return <ModelPicker models={catalogue} selectedId={id} label={catalogue.find((model) => model.id === id)?.label ?? "Automatic"} onSelect={setId}
        onSelectEffort={() => undefined} open={open} onOpenChange={setOpen} />;
    }
    render(<ListHarness />);
    openPicker(); // the selected model has no reasoning levels, so the panel opens straight into the browse view
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(30);
    const longOption = screen.getByRole("menuitemradio", { name: `ChatGPT ${longName}` });
    expect(longOption.querySelector("span[title]")).toHaveAttribute("title", longName);
    expect(screen.getByRole("menuitemradio", { name: "ChatGPT Model 5, unavailable" })).toBeDisabled();
    fireEvent.click(longOption);
    expect(screen.getByRole("slider", { name: "Reasoning effort" })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveTextContent(longName);
  });
});

import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

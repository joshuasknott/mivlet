import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelPicker } from "./ModelPicker";
import type { ProviderModelOption } from "../lib/provider-models";
const models: ProviderModelOption[] = [
  { id: "codex::reasoner", modelId: "reasoner", providerId: "codex", providerLabel: "ChatGPT", label: "Reasoner", available: true, reasoning: { supportedEfforts: ["low", "high"], defaultEffort: "low" } },
  { id: "xai::other", modelId: "other", providerId: "xai", providerLabel: "xAI", label: "Other", available: true }
];
function Harness({ choose = () => undefined }: { choose?: (value: string | undefined) => void }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState(models[0].id);
  const [effort, setEffort] = useState<string>();
  return <><button>Outside</button><ModelPicker models={models} selectedId={id} label={models.find((model) => model.id === id)!.label}
    effort={effort} onSelect={(value) => { setId(value); setEffort(undefined); }}
    onSelectEffort={(value) => { choose(value); setEffort(value); }} open={open} onOpenChange={setOpen} /></>;
}
describe("Model picker", () => {
  it("shows only supported reasoning levels and applies the explicit choice", () => {
    const choose = vi.fn(); render(<Harness choose={choose} />);
    fireEvent.click(screen.getByRole("button", { name: "Select model" }));
    expect(screen.queryByRole("menuitemradio", { name: "Medium" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "High" }));
    expect(choose).toHaveBeenCalledWith("high");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select model" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Select model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "xAI Other" }));
    expect(screen.queryByRole("group", { name: "Reasoning level" })).not.toBeInTheDocument();
  });
  it("supports keyboard navigation, Escape and outside dismissal", () => {
    render(<Harness />); const trigger = screen.getByRole("button", { name: "Select model" });
    fireEvent.click(trigger);
    expect(screen.getByRole("menuitemradio", { name: "ChatGPT Reasoner" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(screen.getByRole("menuitemradio", { name: "xAI Other" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger); fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProviderModelSettings } from "./ProviderModelSettings";

const models = [
  { id: "openai::one", modelId: "one", label: "First model", providerId: "openai", providerLabel: "ChatGPT", available: true },
  { id: "openai::two", modelId: "two", label: "Second model", providerId: "openai", providerLabel: "ChatGPT", available: false },
];
describe("ProviderModelSettings", () => {
  it("shows availability separately from visibility and preserves qualified model selection", () => {
    const onChange = vi.fn();
    render(<ProviderModelSettings models={models} hiddenModelIds={["openai::two"]} onChange={onChange} />);
    expect(screen.getByRole("heading", { name: "Available models 1 available" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /First model/ })).toBeVisible();
    expect(screen.getByText("Unavailable")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: /Second model/ }));
    expect(onChange).toHaveBeenCalledWith("openai::two", true);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Second" } });
    expect(screen.queryByRole("checkbox", { name: /First model/ })).toBeNull();
    expect(screen.getByRole("checkbox", { name: /Second model/ })).toBeVisible();
  });
  it("keeps the models section visible before a provider is connected", () => {
    render(<ProviderModelSettings models={[]} hiddenModelIds={[]} onChange={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Available models 0 available" })).toBeVisible();
    expect(screen.getByText("Connect a provider to see its models here.")).toBeVisible();
  });
});

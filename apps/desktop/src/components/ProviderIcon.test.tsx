import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderIcon } from "./ProviderIcon";

describe("ProviderIcon", () => {
  it("renders the supported provider mark at the requested size", () => {
    const { container } = render(<ProviderIcon provider="openai" size={28} />);
    const mark = container.querySelector('[data-provider-brand="openai"]');

    expect(mark).toHaveAttribute("width", "28");
    expect(mark).toHaveAttribute("height", "28");
    expect(mark).toHaveStyle({ color: "var(--provider-monochrome)" });
    expect(mark).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps the Gemini mark multicolour", () => {
    const { container } = render(<ProviderIcon provider="gemini" />);
    const mark = container.querySelector('[data-provider-brand="gemini"]');
    expect(mark?.querySelectorAll("stop")).toHaveLength(4);
  });

  it.each(["codex", "openai", "anthropic", "gemini", "xai", "custom"])(
    "renders the current %s provider",
    (provider) => {
      const { container } = render(<ProviderIcon provider={provider} />);
      expect(container.querySelector(`[data-provider-brand="${provider}"]`)).toBeTruthy();
    }
  );

  it("falls back to a neutral icon for unknown ids", () => {
    const { container } = render(<ProviderIcon provider="unknown" />);
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelector("[data-provider-brand]")).toBeNull();
  });
});

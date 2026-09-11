import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderIcon } from "./ProviderIcon";

describe("ProviderIcon", () => {
  it("renders the supported provider mark at the requested size", () => {
    const { container } = render(<ProviderIcon provider="openai" size={28} />);
    const mark = container.querySelector('[data-provider-brand="openai"]');

    expect(mark).toHaveAttribute("width", "28");
    expect(mark).toHaveAttribute("height", "28");
    expect(mark).toHaveAttribute("viewBox", "1.68 1.75 16.65 16.5");
    expect(mark).toHaveStyle({ color: "var(--provider-monochrome)" });
    expect(mark).toHaveAttribute("aria-hidden", "true");
  });

  it("uses Google's official full-colour Antigravity icon", () => {
    const { container } = render(<ProviderIcon provider="antigravity" />);
    const mark = container.querySelector('[data-provider-brand="antigravity"]');
    expect(mark).toHaveAttribute("src", "/brand/google-antigravity.png");
    expect(mark).toHaveAttribute("width", "20");
    expect(mark).toHaveAttribute("height", "20");
    expect(mark).toHaveAttribute("aria-hidden", "true");
  });

  it.each([
    ["cursor", "/brand/cursor.svg"],
    ["opencode", "/brand/opencode.svg"],
  ])("uses the official %s artwork asset", (provider, src) => {
    const { container } = render(<ProviderIcon provider={provider} size={16} />);
    const mark = container.querySelector(`[data-provider-brand="${provider}"]`);
    expect(mark?.tagName).toBe("IMG");
    expect(mark).toHaveAttribute("src", src);
    expect(mark).toHaveAttribute("width", "16");
    expect(mark).toHaveAttribute("height", "16");
    expect(mark).toHaveAttribute("aria-hidden", "true");
  });

  it("renders the Anthropic mark in its official terracotta treatment", () => {
    const { container } = render(<ProviderIcon provider="anthropic" />);
    expect(container.querySelector('[data-provider-brand="anthropic"]')).toHaveStyle({
      color: "#D97757",
    });
  });

  it("uses the Grok product mark for xAI", () => {
    const { container } = render(<ProviderIcon provider="xai" />);
    const icon = container.querySelector('[data-provider-brand="grok"]');
    expect(icon).toHaveAttribute("viewBox", "0 0 512 512");
    expect(icon?.querySelector('rect[fill="#050505"]')).toBeTruthy();
  });

  it.each(["codex", "openai", "anthropic", "antigravity", "gemini", "custom"])(
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

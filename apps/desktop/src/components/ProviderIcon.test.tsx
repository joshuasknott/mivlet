import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderIcon } from "./ProviderIcon";

describe("ProviderIcon", () => {
  it("renders provider marks at the requested size with an explicit brand colour", () => {
    const { container } = render(<ProviderIcon provider="openrouter" size={28} />);
    const mark = container.querySelector('[data-provider-brand="openrouter"]');

    expect(mark).toHaveAttribute("width", "28");
    expect(mark).toHaveAttribute("height", "28");
    expect(mark).toHaveStyle({ color: "#6467F2" });
    expect(mark).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps the Gemini mark multicolour", () => {
    const { container } = render(<ProviderIcon provider="gemini" />);
    const mark = container.querySelector('[data-provider-brand="gemini"]');
    const fills = Array.from(mark?.querySelectorAll("path") ?? []).map((path) =>
      path.getAttribute("fill")
    );

    expect(fills).toContain("#3186FF");
    expect(fills.some((fill) => fill?.startsWith("url(#"))).toBe(true);
  });

  it("falls back to the generic provider glyph for unknown ids", () => {
    const { container } = render(<ProviderIcon provider="custom-runtime" />);

    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(container.querySelector("[data-provider-brand]")).not.toBeInTheDocument();
  });

  it.each([
    ["deepseek", "deepseek"],
    ["minimax", "minimax"],
    ["z-ai", "zai"],
    ["qwen", "alibaba"],
    ["moonshot", "kimi"],
    ["kimi-code", "kimi"],
    ["mistral-vibe", "mistral"],
    ["opencode", "opencode"]
  ])("maps %s to its provider-family icon", (provider, family) => {
    const { container } = render(<ProviderIcon provider={provider} />);
    expect(container.querySelector(`[data-provider-brand="${family}"]`)).toBeInTheDocument();
  });
});

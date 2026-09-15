import { readFileSync } from "node:fs";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderIcon } from "./ProviderIcon";

describe("ProviderIcon", () => {
  it("keeps Kimi's blue accent while adapting its letter to the theme", () => {
    const { container } = render(<ProviderIcon provider="moonshot" />);
    expect(container.querySelector("svg")).toHaveStyle({ color: "var(--provider-monochrome)" });
    const artwork = new DOMParser().parseFromString(
      readFileSync("public/brand/additional-provider-artwork.svg", "utf8"), "image/svg+xml",
    );
    const kimi = artwork.querySelector("symbol#moonshot")!;
    expect(kimi.querySelector('path[fill="#1783FF"]')).toBeTruthy();
    expect(kimi.querySelector('path[fill="currentColor"]')).toBeTruthy();
    expect(kimi.querySelector('path[fill="#fff"]')).toBeNull();
  });
  it.each([
    "deepseek", "alibaba", "moonshot", "zai", "groq", "together", "fireworks",
    "cerebras", "mistral", "openrouter", "nvidia", "siliconflow", "cohere",
  ])("resolves %s to bundled brand artwork", (provider) => {
    const { container } = render(<ProviderIcon provider={provider.toUpperCase()} size={16} />);
    const mark = container.querySelector(`[data-provider-brand="${provider}"]`);
    expect(mark).toHaveAttribute("width", "16");
    expect(mark).toHaveAttribute("height", "16");
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark).toHaveStyle({ color: provider === "groq" ? "#F55036" : "var(--provider-monochrome)" });
    expect(mark?.querySelector("use")).toHaveAttribute("href", `/brand/additional-provider-artwork.svg#${provider}`);
    const artwork = new DOMParser().parseFromString(
      readFileSync("public/brand/additional-provider-artwork.svg", "utf8"), "image/svg+xml",
    );
    expect(artwork.querySelector("parsererror")).toBeNull();
    expect(artwork.querySelector(`symbol#${provider} path`)).toBeTruthy();
  });

  it("preserves multicolour artwork and local gradient references", () => {
    const artwork = new DOMParser().parseFromString(
      readFileSync("public/brand/additional-provider-artwork.svg", "utf8"), "image/svg+xml",
    );
    for (const id of ["deepseek", "alibaba", "moonshot", "together", "fireworks", "cerebras", "mistral", "openrouter", "nvidia", "siliconflow", "cohere"]) {
      const symbol = artwork.querySelector(`symbol#${id}`)!;
      expect(symbol).toBeTruthy();
      expect(symbol.outerHTML).toMatch(/(?:fill|stop-color)="#[0-9A-Fa-f]+"/);
      for (const reference of symbol.outerHTML.matchAll(/url\(#([^)]+)\)/g)) {
        expect(artwork.getElementById(reference[1])).toBeTruthy();
      }
    }
    const cohere = artwork.querySelector("#cohere")!;
    expect(new Set([...cohere.querySelectorAll("[fill]")].map(node => node.getAttribute("fill"))).size).toBeGreaterThan(1);
  });

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

  it("renders the official Claude symbol instead of the Anthropic company monogram", () => {
    const { container } = render(<ProviderIcon provider="anthropic" />);
    expect(container.querySelector("svg")).toHaveAttribute("viewBox", "0 0 125 125");
    const artwork = new DOMParser().parseFromString(readFileSync("public/brand/provider-artwork.svg", "utf8"), "image/svg+xml");
    expect(artwork.querySelector("#anthropic path")?.getAttribute("fill")).toBe("#D97757");
    expect(artwork.querySelector("#anthropic path")?.getAttribute("d")).not.toContain("M17.3041 3.541");

    expect(container.querySelector('[data-provider-brand="anthropic"]')).toHaveStyle({
      color: "#D97757",
    });
  });

  it("uses the Grok product mark for xAI", () => {
    const { container } = render(<ProviderIcon provider="xai" />);
    const icon = container.querySelector('[data-provider-brand="grok"]');
    expect(icon).toHaveAttribute("viewBox", "0 0 512 512");
    expect(icon?.querySelector("use")).toHaveAttribute("href", "/brand/provider-artwork.svg#xai");
    const artwork = new DOMParser().parseFromString(readFileSync("public/brand/provider-artwork.svg", "utf8"), "image/svg+xml");
    expect(artwork.querySelector('#xai rect[fill="#050505"]')).toBeTruthy();
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

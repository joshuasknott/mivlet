/**
 * @vitest-environment node
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const indexPath = join(__dirname, "..", "styles.css");
const responsivePath = join(__dirname, "responsive.css");
const tokensPath = join(__dirname, "tokens.css");

function themeVariables(source: string, selector: RegExp) {
  const block = source.match(selector)?.[1];
  if (!block) throw new Error("Missing theme token block");
  return new Map(
    [...block.matchAll(/--([\w-]+):\s*(#[a-f\d]{6});/gi)].map((match) => [
      match[1],
      match[2].toLowerCase()
    ])
  );
}

function relativeLuminance(hex: string) {
  const channels = hex
    .slice(1)
    .match(/../g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4
    );
  if (!channels || channels.length !== 3) throw new Error(`Invalid colour ${hex}`);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("desktop motion accessibility", () => {
  it("loads a global reduced-motion policy after every product style layer", () => {
    const index = readFileSync(indexPath, "utf8");
    const responsive = readFileSync(responsivePath, "utf8");

    expect(index.trimEnd()).toMatch(/@import "\.\/styles\/responsive\.css";$/);
    expect(responsive).toContain("@media (prefers-reduced-motion: reduce)");
    expect(responsive).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{/);
    expect(responsive).toContain("animation-duration: 0.01ms !important;");
    expect(responsive).toContain("animation-delay: 0ms !important;");
    expect(responsive).toContain("animation-iteration-count: 1 !important;");
    expect(responsive).toContain("transition-duration: 0.01ms !important;");
    expect(responsive).toContain("scroll-behavior: auto !important;");
  });

  it("keeps normal-size semantic text at WCAG AA contrast in both themes", () => {
    const source = readFileSync(tokensPath, "utf8");
    const light = themeVariables(source, /:root\s*\{([\s\S]*?)\n\}/);
    const dark = themeVariables(
      source,
      /:root\[data-theme="dark"\],[\s\S]*?\{([\s\S]*?)\n\}/
    );
    const requiredPairs = [
      [light, "light", "ink-soft", "surface"],
      [light, "light", "ink-soft", "surface-raised"],
      [light, "light", "ink-soft", "surface-hover"],
      [light, "light", "positive", "positive-subtle"],
      [light, "light", "caution", "caution-subtle"],
      [light, "light", "destructive", "destructive-subtle"],
      [dark, "dark", "ink-soft", "surface"],
      [dark, "dark", "ink-soft", "surface-raised"],
      [dark, "dark", "ink-soft", "surface-hover"],
      [dark, "dark", "positive", "surface-raised"],
      [dark, "dark", "caution", "surface-raised"],
      [dark, "dark", "destructive", "surface-raised"]
    ] as const;

    for (const [tokens, theme, foregroundName, backgroundName] of requiredPairs) {
      const foreground = tokens.get(foregroundName);
      const background = tokens.get(backgroundName);
      if (!foreground || !background) {
        throw new Error(`Missing ${theme} ${foregroundName}/${backgroundName} token`);
      }
      expect(
        contrastRatio(foreground, background),
        `${theme} ${foregroundName} on ${backgroundName}`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

/**
 * @vitest-environment node
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const indexPath = join(__dirname, "..", "styles.css");
const responsivePath = join(__dirname, "responsive.css");

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
});

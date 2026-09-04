import { describe, expect, it } from "vitest";
import {
  marketplaceConnectorEntries,
  marketplaceConnectorSections,
  recommendedMarketplaceConnectors,
} from "./marketplace-catalog";

describe("connector marketplace catalogue", () => {
  it("covers the capability groups without duplicate catalogue entries", () => {
    expect(
      marketplaceConnectorSections.map((section) => section.title),
    ).toEqual([
      "Work & knowledge",
      "Communication & meetings",
      "Product & design",
      "Engineering & delivery",
      "Data & analytics",
      "Sales & CRM",
      "Marketing & social",
      "Commerce & support",
      "Finance & accounting",
      "Legal & compliance",
      "People & recruiting",
      "Operations, security & automation",
      "Research & learning",
    ]);
    expect(
      new Set(marketplaceConnectorEntries.map((entry) => entry.id)).size,
    ).toBe(marketplaceConnectorEntries.length);
  });

  it("keeps the implemented connector families prominent", () => {
    const entries = new Set(
      marketplaceConnectorEntries.map((entry) => entry.id),
    );
    for (const id of [
      "gmail",
      "github",
      "google-drive",
      "google-calendar",
      "slack",
      "notion",
      "vercel",
      "linear",
    ]) {
      expect(entries.has(id)).toBe(true);
    }
    expect(recommendedMarketplaceConnectors.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        "gmail",
        "github",
        "google-drive",
        "google-calendar",
      ]),
    );
  });
});

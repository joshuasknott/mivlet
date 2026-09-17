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
      "Commerce & support",
    ]);
    expect(
      new Set(marketplaceConnectorEntries.map((entry) => entry.id)).size,
    ).toBe(marketplaceConnectorEntries.length);
  });

  it("never lists a removed plugin or an empty category", () => {
    const removed = ["outlook", "microsoft-teams", "zoom", "linkedin", "instagram", "youtube", "google-ads", "meta-ads", "shopify", "docusign", "greenhouse", "lever", "workday"];
    expect(marketplaceConnectorEntries.filter((entry) => removed.includes(entry.id))).toEqual([]);
    expect(marketplaceConnectorSections.every((section) => section.connectors.length > 0)).toBe(true);
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
      "atlassian-rovo",
    ]) {
      expect(entries.has(id)).toBe(true);
    }
    expect(entries.has("todoist")).toBe(false);
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

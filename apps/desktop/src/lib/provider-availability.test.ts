import { describe, expect, it } from "vitest";
import { isMivletProviderEnabled } from "./provider-availability";

describe("Mivlet provider availability", () => {
  it("keeps the hosted xAI API connection available", () => {
    expect(isMivletProviderEnabled("xai")).toBe(true);
  });

  it("registers the Grok ACP instance without reviving the retired CLI alias", () => {
    expect(isMivletProviderEnabled("grok")).toBe(true);
    expect(isMivletProviderEnabled("grok-cli")).toBe(false);
  });
});

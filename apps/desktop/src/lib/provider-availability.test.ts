import { describe, expect, it } from "vitest";
import { isFableProviderEnabled } from "./provider-availability";

describe("Mivlet provider availability", () => {
  it("keeps the hosted xAI API connection available", () => {
    expect(isFableProviderEnabled("xai")).toBe(true);
  });

  it("registers the Grok ACP instance without reviving the retired CLI alias", () => {
    expect(isFableProviderEnabled("grok")).toBe(true);
    expect(isFableProviderEnabled("grok-cli")).toBe(false);
  });
});

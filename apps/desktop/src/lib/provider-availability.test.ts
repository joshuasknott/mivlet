import { describe, expect, it } from "vitest";
import { isFableProviderEnabled } from "./provider-availability";

describe("Fable provider availability", () => {
  it("keeps the hosted xAI API connection available", () => {
    expect(isFableProviderEnabled("xai")).toBe(true);
  });

  it("does not offer the retired CLI-only Grok path", () => {
    expect(isFableProviderEnabled("grok")).toBe(false);
  });
});

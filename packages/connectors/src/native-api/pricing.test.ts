import { describe, expect, it } from "vitest";
import { hasKnownPrice, priceFor } from "./pricing";

describe("priceFor", () => {
  it("does not invent a provider-wide hosted-model price", () => {
    expect(priceFor("openai", 1_000_000, 1_000_000)).toBe(0);
    expect(hasKnownPrice("openai")).toBe(false);
  });

  it("returns 0 cost for 0 tokens", () => {
    expect(priceFor("anthropic", 0, 0)).toBe(0);
  });

  it("returns 0 cost for an unknown provider (fail-safe, never negative)", () => {
    expect(priceFor("unknown", 1_000_000, 1_000_000)).toBe(0);
    expect(hasKnownPrice("unknown")).toBe(false);
  });

  it("keeps every provider unknown without an exact model observation", () => {
    for (const providerId of ["openai", "anthropic", "gemini", "xai", "custom"]) {
      expect(priceFor(providerId, 1_000_000, 1_000_000)).toBe(0);
      expect(hasKnownPrice(providerId)).toBe(false);
    }
  });
});

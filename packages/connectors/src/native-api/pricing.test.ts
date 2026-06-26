import { describe, expect, it } from "vitest";
import { priceFor } from "./pricing";

describe("priceFor", () => {
  it("returns a non-negative cost for known providers", () => {
    expect(priceFor("openai", 1_000_000, 1_000_000)).toBeGreaterThan(0);
  });

  it("returns 0 cost for 0 tokens", () => {
    expect(priceFor("anthropic", 0, 0)).toBe(0);
  });

  it("returns 0 cost for an unknown provider (fail-safe, never negative)", () => {
    expect(priceFor("unknown", 1_000_000, 1_000_000)).toBe(0);
  });

  it("scales linearly with token count", () => {
    const one = priceFor("gemini", 1_000_000, 0);
    const two = priceFor("gemini", 2_000_000, 0);
    expect(two).toBeCloseTo(one * 2, 6);
  });
});

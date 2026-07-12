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

  it("does not invent one provider-wide price for model-dependent providers", () => {
    for (const providerId of [
      "deepseek", "zai", "minimax", "alibaba", "fireworks", "huggingface",
      "moonshot", "kimi-code", "mistral", "meta", "ollama", "perplexity", "tencent",
      "xiaomi", "groq", "together", "cerebras", "custom"
    ]) {
      expect(priceFor(providerId, 1_000_000, 1_000_000), providerId).toBe(0);
    }
  });

  it("keeps every provider unknown without an exact model observation", () => {
    for (const providerId of ["openai", "anthropic", "gemini", "xai", "openrouter"]) {
      expect(priceFor(providerId, 1_000_000, 1_000_000)).toBe(0);
      expect(hasKnownPrice(providerId)).toBe(false);
    }
  });
});

import { describe, expect, it } from "vitest";
import type { BackendModel } from "@fable/protocol";
import {
  catalogueCapabilities,
  defaultDiscoveredCapabilities,
  MAX_TOKENS_DEFAULT,
  resolveModelCapabilities,
  validateModelForRun
} from "./model-catalogue";

describe("catalogueCapabilities", () => {
  it("returns known capabilities for a curated model", () => {
    const caps = catalogueCapabilities("openai", "gpt-5");
    expect(caps).toBeDefined();
    expect(caps?.contextWindow).toBeGreaterThan(0);
    expect(caps?.maxOutputTokens).toBeGreaterThan(0);
    expect(caps?.streaming).toBe(true);
    expect(caps?.tools).toBe(true);
  });

  it("returns undefined for an unknown model (never fabricated)", () => {
    expect(catalogueCapabilities("openai", "no-such-model")).toBeUndefined();
  });

  it("returns undefined for an unknown provider", () => {
    expect(catalogueCapabilities("made-up", "gpt-5")).toBeUndefined();
  });

  it("covers every native fixture model id", () => {
    // Every model surfaced in the native fixtures must have a curated entry, so
    // the fallback catalogue is truthful for the models the UI advertises.
    const expected: Record<string, string[]> = {
      openai: ["gpt-5.2", "gpt-5", "gpt-4.1"],
      anthropic: ["claude-sonnet-4-6", "claude-opus-4-8"],
      gemini: ["gemini-3.5-flash", "gemini-2.5-pro"],
      xai: ["grok-4"],
      openrouter: ["openrouter:auto", "openrouter:claude"]
    };
    for (const [provider, ids] of Object.entries(expected)) {
      for (const id of ids) {
        expect(catalogueCapabilities(provider, id), `${provider}/${id}`).toBeDefined();
      }
    }
  });
});

describe("defaultDiscoveredCapabilities", () => {
  it("provides conservative defaults for known native providers only", () => {
    expect(defaultDiscoveredCapabilities("openai")).toMatchObject({
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      streaming: true,
      tools: false
    });
    expect(defaultDiscoveredCapabilities("made-up")).toBeUndefined();
  });
});

describe("resolveModelCapabilities", () => {
  it("prefers the model entry's own capabilities", () => {
    const model: BackendModel = {
      id: "gpt-5",
      label: "GPT-5",
      available: true,
      capabilities: {
        contextWindow: 999,
        maxOutputTokens: 999,
        streaming: true,
        tools: false,
        vision: false,
        reasoning: false,
        structuredOutput: false
      }
    };
    expect(resolveModelCapabilities("openai", model)?.contextWindow).toBe(999);
  });

  it("falls back to the catalogue when the entry has no capabilities", () => {
    const model: BackendModel = { id: "gpt-5", label: "GPT-5", available: true };
    expect(resolveModelCapabilities("openai", model)?.tools).toBe(true);
  });

  it("returns undefined when neither source knows the model", () => {
    expect(resolveModelCapabilities("openai", undefined)).toBeUndefined();
  });
});

describe("validateModelForRun", () => {
  const models: BackendModel[] = [
    { id: "gpt-5", label: "GPT-5", available: true },
    { id: "old", label: "Old", available: false }
  ];

  it("rejects an empty model id", () => {
    const result = validateModelForRun("openai", "", models);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no model/i);
  });

  it("rejects an unknown model", () => {
    const result = validateModelForRun("openai", "ghost", models);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not known/i);
  });

  it("rejects an unavailable model", () => {
    const result = validateModelForRun("openai", "old", models);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not available/i);
  });

  it("rejects an available model whose execution capabilities are unknown", () => {
    const result = validateModelForRun(
      "openai",
      "future-model",
      [{ id: "future-model", label: "Future", available: true }]
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown execution capabilities/i);
  });

  it("clamps maxTokens to the model's output ceiling", () => {
    const result = validateModelForRun("openai", "gpt-5", models, 1_000_000);
    const ceiling = catalogueCapabilities("openai", "gpt-5")!.maxOutputTokens;
    expect(result.ok).toBe(true);
    expect(result.maxTokens).toBe(ceiling);
  });

  it("keeps a below-ceiling maxTokens unchanged", () => {
    const result = validateModelForRun("openai", "gpt-5", models, 512);
    expect(result.ok).toBe(true);
    expect(result.maxTokens).toBe(512);
  });

  it("uses the default maxTokens when none is requested", () => {
    const result = validateModelForRun("openai", "gpt-5", models);
    expect(result.maxTokens).toBe(MAX_TOKENS_DEFAULT);
    expect(result.capabilities).toBeDefined();
  });

  it("rejects a model whose catalogue entry excludes streaming", () => {
    const nonStreaming: BackendModel[] = [
      {
        id: "embed",
        label: "Embed",
        available: true,
        capabilities: {
          contextWindow: 8_000,
          maxOutputTokens: 256,
          streaming: false,
          tools: false,
          vision: false,
          reasoning: false,
          structuredOutput: false
        }
      }
    ];
    const result = validateModelForRun("openai", "embed", nonStreaming);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/streaming/i);
  });
});

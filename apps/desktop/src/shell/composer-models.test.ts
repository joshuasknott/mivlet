import { describe, expect, it } from "vitest";
import { composerModelsFor } from "./composer-models";

const model = (id: string, providerId = "openai", available = true) => ({
  id,
  modelId: id,
  label: id,
  providerId,
  providerLabel: providerId,
  available
});

describe("composerModelsFor", () => {
  it("prefers current OpenAI and reasoning models when GPT-5 is available", () => {
    expect(composerModelsFor("openai", [model("gpt-4.1"), model("o3"), model("gpt-5")]).map((item) => item.id)).toEqual([
      "o3",
      "gpt-5"
    ]);
  });

  it("keeps only the newest Gemini version and ignores unavailable models", () => {
    expect(
      composerModelsFor("gemini", [model("gemini-2.5", "gemini"), model("gemini-3.0", "gemini"), model("gemini-4.0", "gemini", false)]).map(
        (item) => item.id
      )
    ).toEqual(["gemini-3.0"]);
  });

  it("returns a bounded provider-specific fallback list", () => {
    expect(composerModelsFor("anthropic", Array.from({ length: 25 }, (_, index) => model(`claude-${index}`, "anthropic"))).length).toBe(24);
  });
});

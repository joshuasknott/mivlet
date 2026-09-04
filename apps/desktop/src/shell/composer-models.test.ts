import { describe, expect, it } from "vitest";
import { composerModelsFor } from "./composer-models";

const model = (id: string, providerId = "openai", available = true) => ({
  id: `${providerId}::${id}`,
  modelId: id,
  label: id,
  providerId,
  providerLabel: providerId,
  available,
});

describe("composerModelsFor", () => {
  it("keeps models from every connected provider when the composer is switching providers", () => {
    expect(
      composerModelsFor(undefined, [
        model("gpt-5", "codex"),
        model("fable-smoke", "custom"),
      ]).map((item) => item.id),
    ).toEqual(["codex::gpt-5", "custom::fable-smoke"]);
  });

  it("prefers current OpenAI and reasoning models when GPT-5 is available", () => {
    expect(
      composerModelsFor("openai", [
        model("gpt-4.1"),
        model("o3"),
        model("gpt-5"),
      ]).map((item) => item.modelId),
    ).toEqual(["o3", "gpt-5"]);
  });

  it("keeps only the newest Antigravity Gemini version and ignores unavailable models", () => {
    expect(
      composerModelsFor("antigravity", [
        model("gemini-2.5", "antigravity"),
        model("gemini-3.0", "antigravity"),
        model("gemini-4.0", "antigravity", false),
      ]).map((item) => item.modelId),
    ).toEqual(["gemini-3.0"]);
  });

  it("returns a bounded provider-specific fallback list", () => {
    expect(
      composerModelsFor(
        "anthropic",
        Array.from({ length: 25 }, (_, index) =>
          model(`claude-${index}`, "anthropic"),
        ),
      ).length,
    ).toBe(24);
  });
});

import { describe, expect, it } from "vitest";
import { modelReasoning, validateReasoningEffort } from "./reasoning";
import { shapeOpenAiRequest } from "./openai-compat";
import { shapeAnthropicRequest } from "./anthropic";
import { shapeGeminiRequest } from "./gemini";
import { mergeDiscoveredModels } from "./discovery";

const request = { providerId: "openai", model: "gpt-5.2", messages: [{ role: "user" as const, content: "Plan a week" }], tools: [], maxTokens: 4096, reasoningEffort: "high" };
const model = { id: "gpt-5.2", label: "GPT-5.2", available: true };
describe("provider reasoning controls", () => {
  it("sends the selected level through each provider's own field", () => {
    expect(shapeOpenAiRequest(request)).toMatchObject({ reasoning_effort: "high" });
    expect(shapeAnthropicRequest({ ...request, providerId: "anthropic", model: "claude-sonnet-4-6" })).toMatchObject({ output_config: { effort: "high" } });
    expect(shapeGeminiRequest({ ...request, providerId: "gemini", model: "gemini-3.5-flash" })).toMatchObject({ generationConfig: { thinkingConfig: { thinkingLevel: "high" } } });
    expect(shapeOpenAiRequest({ ...request, reasoningEffort: undefined })).not.toHaveProperty("reasoning_effort");
  });
  it("rejects unknown and cross-model choices instead of silently dropping them", () => {
    expect(() => validateReasoningEffort("openai", model, "xhigh")).not.toThrow();
    expect(() => validateReasoningEffort("openai", { ...model, id: "gpt-5" }, "xhigh")).toThrow("does not support");
    expect(() => validateReasoningEffort("xai", { ...model, id: "grok-4" }, "high")).toThrow("does not support");
    expect(modelReasoning("openai", { ...model, id: "future-model" })).toBeUndefined();
    expect(() => validateReasoningEffort("openai", undefined, undefined)).not.toThrow();
  });
  it("preserves a live runtime's supported levels through model discovery", () => {
    const reasoning = { supportedEfforts: ["low", "high", "ultra"], defaultEffort: "high" };
    const [merged] = mergeDiscoveredModels({ providerId: "codex", catalogueModels: [{ ...model, reasoning }], discovered: [{ id: model.id, available: true }], connected: true, discoveryRan: true });
    expect(merged.reasoning).toEqual(reasoning);
  });
});

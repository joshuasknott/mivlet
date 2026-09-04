import type { BackendModel } from "@fable/protocol";

type Reasoning = NonNullable<BackendModel["reasoning"]>;
const levels = (supportedEfforts: string[], defaultEffort: string): Reasoning => ({
  supportedEfforts, defaultEffort
});

// Exact model IDs only. A newly discovered model must not inherit another
// model's controls. Codex supplies its own live catalogue instead of this map.
// Sources checked 2026-09-04:
// developers.openai.com/api/docs/models/gpt-5 and /gpt-5.2
// platform.claude.com/docs/en/build-with-claude/effort
// ai.google.dev/gemini-api/docs/generate-content/thinking
const REASONING: Record<string, Record<string, Reasoning>> = {
  openai: {
    "gpt-5": levels(["minimal", "low", "medium", "high"], "medium"),
    "gpt-5.2": levels(["none", "low", "medium", "high", "xhigh"], "none")
  },
  anthropic: {
    "claude-sonnet-4-6": levels(["low", "medium", "high", "max"], "high"),
    "claude-opus-4-6": levels(["low", "medium", "high", "max"], "high"),
    "claude-opus-4-7": levels(["low", "medium", "high", "xhigh", "max"], "high"),
    "claude-opus-4-8": levels(["low", "medium", "high", "xhigh", "max"], "high")
  },
  gemini: {
    "gemini-3.5-flash": levels(["minimal", "low", "medium", "high"], "medium"),
    "gemini-3.1-pro-preview": levels(["low", "medium", "high"], "high"),
    "gemini-3-flash-preview": levels(["minimal", "low", "medium", "high"], "high")
  }
};

export function modelReasoning(providerId: string, model: BackendModel): Reasoning | undefined {
  return model.reasoning ?? REASONING[providerId]?.[model.id];
}

/** Fail before transport when a stale or forged choice is unsupported. */
export function validateReasoningEffort(
  providerId: string, model: BackendModel | undefined, effort: string | undefined
): void {
  if (effort === undefined) return;
  if (!model || !modelReasoning(providerId, model)?.supportedEfforts.includes(effort)) {
    throw new Error("This model does not support the selected reasoning level. Choose a level again.");
  }
}

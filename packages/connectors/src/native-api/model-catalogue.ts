/**
 * Curated per-model capability catalogue for the native-API providers.
 *
 * This is the **fallback catalogue** used when dynamic discovery is unavailable
 * (offline, preview/test runtime, discovery failure, or a provider that does
 * not expose a list-models endpoint). Values are conservative public ceilings
 * from each provider's model documentation — used only for capability truth and
 * context-budget decisions, never for billing (usage stays provider-reported).
 *
 * Hard invariant: an unknown model id returns `undefined`. Callers must treat
 * `undefined` as "capabilities unknown" and fail conservatively — this module
 * NEVER fabricates a capability it does not have evidence for.
 *
 * Compliance: this catalogue does not assert pricing, entitlements, or tier
 * availability — only technical capability ceilings. It is pure data (no
 * network, no key) and therefore fixture-testable.
 */

import type { BackendModel, ModelCapabilities } from "@fable/protocol";

/**
 * The default max-tokens value the agent loop requests when a model's output
 * ceiling is unknown. Kept conservative so it stays under typical provider
 * limits; the loop clamps it down when {@link ModelCapabilities.maxOutputTokens}
 * is known.
 */
export const MAX_TOKENS_DEFAULT = 2_048;

/**
 * Per-provider, per-model capability entries. Model ids match the ids surfaced
 * in the native fixtures and (when discovery runs) the provider's own list. A
 * provider that is missing from this map simply has no curated entries — its
 * models return `undefined` (unknown) until discovery supplies metadata.
 */
const CATALOGUE: Record<string, Record<string, ModelCapabilities>> = {
  openai: {
    "gpt-5.2": {
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      streaming: true,
      tools: true,
      vision: true,
      reasoning: true,
      structuredOutput: true
    },
    "gpt-5": {
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      streaming: true,
      tools: true,
      vision: true,
      reasoning: true,
      structuredOutput: true
    },
    "gpt-4.1": {
      contextWindow: 1_000_000,
      maxOutputTokens: 32_768,
      streaming: true,
      tools: true,
      vision: true,
      reasoning: false,
      structuredOutput: true
    }
  },
  anthropic: {
    "claude-sonnet-4-6": {
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      streaming: true,
      tools: true,
      vision: true,
      reasoning: true,
      structuredOutput: true
    },
    "claude-opus-4-8": {
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      streaming: true,
      tools: true,
      vision: true,
      reasoning: true,
      structuredOutput: true
    }
  },
  gemini: {
    "gemini-3.5-flash": {
      contextWindow: 1_000_000,
      maxOutputTokens: 65_536,
      streaming: true,
      tools: true,
      vision: true,
      reasoning: true,
      structuredOutput: true
    },
    "gemini-2.5-pro": {
      contextWindow: 2_000_000,
      maxOutputTokens: 65_536,
      streaming: true,
      tools: true,
      vision: true,
      reasoning: true,
      structuredOutput: true
    }
  },
  xai: {
    "grok-4": {
      contextWindow: 256_000,
      maxOutputTokens: 32_768,
      streaming: true,
      tools: true,
      vision: true,
      reasoning: true,
      structuredOutput: false
    }
  },
  openrouter: {
    // OpenRouter routes to upstream models, so the catalogue only records the
    // synthetic routing aliases surfaced in the fixtures. Real upstream limits
    // are honored from discovery when available; these are conservative.
    "openrouter:auto": {
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      streaming: true,
      tools: true,
      vision: false,
      reasoning: false,
      structuredOutput: false
    },
    "openrouter:claude": {
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      streaming: true,
      tools: true,
      vision: true,
      reasoning: true,
      structuredOutput: true
    }
  }
};

/**
 * Look up the curated capabilities for a (providerId, modelId) pair. Returns
 * `undefined` when the model is not in the catalogue — callers must treat that
 * as "unknown", never fabricate a capability set.
 */
export function catalogueCapabilities(
  providerId: string,
  modelId: string
): ModelCapabilities | undefined {
  return CATALOGUE[providerId]?.[modelId];
}

/**
 * Resolve the capabilities to use for a run. Prefers the model entry's own
 * capabilities (set from discovery metadata) and falls back to the curated
 * catalogue. Returns `undefined` when neither source knows the model.
 */
export function resolveModelCapabilities(
  providerId: string,
  model: BackendModel | undefined
): ModelCapabilities | undefined {
  if (model?.capabilities) return model.capabilities;
  if (model?.id) return catalogueCapabilities(providerId, model.id);
  return undefined;
}

/** The result of validating a model selection before a run starts. */
export interface ModelValidation {
  /** True when the model may be used for a run. */
  ok: boolean;
  /** A normalized, user-facing reason when `ok` is false. */
  error?: string;
  /** The resolved capabilities, if any were found. */
  capabilities?: ModelCapabilities;
  /**
   * The maxTokens value clamped to the model's output ceiling (or the request's
   * value when capabilities are unknown). Always finite and >= 1.
   */
  maxTokens: number;
}

/**
 * Validate a model selection before a run starts. Fail-closed: an empty,
 * unknown, or unavailable model — or one whose catalogue/discovery entry says
 * it cannot stream — rejects with a normalized error rather than being sent.
 *
 * @param providerId  The native provider id.
 * @param modelId     The model id the run would use.
 * @param models      The provider's selectable models (from the registry /
 *                    discovery merge) so availability is checked truthfully.
 * @param requestedMaxTokens  The caller's requested max output tokens.
 */
export function validateModelForRun(
  providerId: string,
  modelId: string,
  models: BackendModel[],
  requestedMaxTokens = MAX_TOKENS_DEFAULT
): ModelValidation {
  if (!modelId || modelId.trim().length === 0) {
    return { ok: false, error: "No model selected for this run.", maxTokens: requestedMaxTokens };
  }
  const model = models.find((entry) => entry.id === modelId);
  if (!model) {
    return {
      ok: false,
      error: `Model "${modelId}" is not known to this provider.`,
      maxTokens: requestedMaxTokens
    };
  }
  if (!model.available) {
    return {
      ok: false,
      error: `Model "${modelId}" is not available on the connected provider.`,
      maxTokens: requestedMaxTokens
    };
  }
  const capabilities = resolveModelCapabilities(providerId, model);
  if (capabilities && !capabilities.streaming) {
    return {
      ok: false,
      error: `Model "${modelId}" does not support streaming runs.`,
      capabilities,
      maxTokens: requestedMaxTokens
    };
  }
  const maxTokens =
    capabilities && requestedMaxTokens > capabilities.maxOutputTokens
      ? capabilities.maxOutputTokens
      : Math.max(1, requestedMaxTokens);
  return { ok: true, capabilities, maxTokens };
}

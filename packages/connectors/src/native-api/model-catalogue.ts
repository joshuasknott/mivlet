/** Honest capability fallback for the direct providers Mivlet currently ships. */

import type { BackendModel, ModelCapabilities } from "@fable/protocol";

export const MAX_TOKENS_DEFAULT = 2_048;

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
  // Official DeepSeek platform facts reviewed 2026-09-11:
  // - Model IDs: deepseek-flash (DeepSeek-V4.1-Flash) and deepseek-v4-pro.
  //   Legacy deepseek-v4-flash* ids are retired; requests are served by
  //   DeepSeek-V4.1-Flash (api-docs.deepseek.com quick-start "Your First API Call").
  // - Context length 1M and max output ceiling 384K for both models
  //   (api-docs.deepseek.com quick_start/pricing "Model Details").
  // - Non-thinking default output is 8K; Mivlet runs non-thinking mode only, so
  //   the conservative 8K ceiling is used instead of the 384K maximum.
  // - Streaming, tool calls, and JSON output are documented for both models.
  // - Thinking mode is a documented option, but the reasoning_content
  //   round-trip contract (400 when omitted on tool turns) is not bridged by
  //   the shared OpenAI-compatible shaper, so Mivlet disables thinking mode at
  //   the Rust egress boundary and does not advertise reasoning levels here.
  // - deepseek-flash documents vision input, but Mivlet has no audited
  //   screenshot/visual bridge for the DeepSeek route; vision stays unadvertised.
  deepseek: {
    "deepseek-flash": {
      contextWindow: 1_000_000,
      maxOutputTokens: 8_192,
      streaming: true,
      tools: true,
      vision: false,
      reasoning: false,
      structuredOutput: false
    },
    "deepseek-v4-pro": {
      contextWindow: 1_000_000,
      maxOutputTokens: 8_192,
      streaming: true,
      tools: true,
      vision: false,
      reasoning: false,
      structuredOutput: false
    }
  }
};

export function catalogueCapabilities(
  providerId: string,
  modelId: string
): ModelCapabilities | undefined {
  return CATALOGUE[providerId]?.[modelId];
}

/** Conservative ceilings for new models returned by live discovery. */
export function defaultDiscoveredCapabilities(
  providerId: string
): ModelCapabilities | undefined {
  if (!["openai", "anthropic", "gemini", "xai", "deepseek"].includes(providerId)) {
    return undefined;
  }
  return {
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    streaming: true,
    tools: false,
    vision: false,
    reasoning: false,
    structuredOutput: false
  };
}

export function resolveModelCapabilities(
  providerId: string,
  model: BackendModel | undefined
): Partial<ModelCapabilities> | undefined {
  if (model?.capabilities) return model.capabilities;
  if (model?.id) return catalogueCapabilities(providerId, model.id);
  return undefined;
}

export interface ModelValidation {
  ok: boolean;
  error?: string;
  capabilities?: Partial<ModelCapabilities>;
  maxTokens: number;
}

export function validateModelForRun(
  providerId: string,
  modelId: string,
  models: BackendModel[],
  requestedMaxTokens = MAX_TOKENS_DEFAULT
): ModelValidation {
  if (!modelId.trim()) {
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
  if (!capabilities) {
    return { ok: true, maxTokens: requestedMaxTokens };
  }
  if (capabilities.streaming === false) {
    return {
      ok: false,
      error: `Model "${modelId}" does not support streaming runs.`,
      capabilities,
      maxTokens: requestedMaxTokens
    };
  }
  return {
    ok: true,
    capabilities,
    maxTokens: Math.min(capabilities.maxOutputTokens ?? requestedMaxTokens, Math.max(1, requestedMaxTokens))
  };
}

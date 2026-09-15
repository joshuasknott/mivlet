import type { ModelCapabilities } from "@fable/protocol";

/** Direct API routes reviewed against the linked vendor documentation on 2026-09-12.
 * Budgets are conservative Mivlet limits. Tool support applies only to these
 * exact model IDs; discovery does not infer vision, reasoning, or tool support.
 */
export const additionalNativeProviderCatalog = [
  {
    providerId: "alibaba",
    label: "Qwen",
    description: "Use Qwen through Alibaba Cloud Model Studio. Choose the endpoint matching your API key's region and workspace.",
    authLabel: "Qwen API key",
    documentation: "https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope",
    contextWindow: 128_000,
    models: [{ id: "qwen-plus", label: "Qwen Plus" }, { id: "qwen-turbo", label: "Qwen Turbo" }, { id: "qwen3-coder-plus", label: "Qwen3 Coder Plus" }],
  },
  {
    providerId: "moonshot",
    label: "Kimi",
    description: "Use Kimi through Moonshot's international API in non-thinking mode.",
    authLabel: "Kimi API key",
    documentation: "https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart",
    contextWindow: 256_000,
    models: [{ id: "kimi-k2.6", label: "Kimi K2.6" }],
  },
  {
    providerId: "zai",
    label: "Z.ai",
    description: "Use GLM through Z.ai's standard API in non-thinking mode. Coding Plan keys use a separate service.",
    authLabel: "Z.ai API key",
    documentation: "https://docs.z.ai/guides/capabilities/thinking-mode",
    contextWindow: 128_000,
    models: [{ id: "glm-4.7", label: "GLM 4.7" }, { id: "glm-4.5-air", label: "GLM 4.5 Air" }],
  },
  {
    providerId: "groq",
    label: "Groq",
    description: "Use open models through Groq's inference API.",
    authLabel: "Groq API key",
    documentation: "https://console.groq.com/docs/tool-use/overview",
    contextWindow: 128_000,
    models: [{ id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" }, { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B" }],
  },
  {
    providerId: "together",
    label: "Together",
    description: "Use open models through Together AI's inference API.",
    authLabel: "Together AI API key",
    documentation: "https://docs.together.ai/docs/inference/openai-compatibility",
    contextWindow: 128_000,
    models: [{ id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", label: "Llama 3.3 70B Turbo" }],
  },
  {
    providerId: "fireworks",
    label: "Fireworks",
    description: "Use serverless models through Fireworks AI's inference API.",
    authLabel: "Fireworks AI API key",
    documentation: "https://docs.fireworks.ai/tools-sdks/openai-compatibility",
    contextWindow: 128_000,
    models: [{ id: "accounts/fireworks/models/gpt-oss-120b", label: "GPT OSS 120B" }],
  },
  {
    providerId: "cerebras",
    label: "Cerebras",
    description: "Use models through Cerebras Inference.",
    authLabel: "Cerebras API key",
    documentation: "https://inference-docs.cerebras.ai/resources/openai",
    contextWindow: 65_000,
    models: [{ id: "gpt-oss-120b", label: "GPT OSS 120B" }],
  },
  {
    providerId: "mistral",
    label: "Mistral",
    description: "Use Mistral models with a La Plateforme API key.",
    authLabel: "Mistral API key",
    documentation: "https://docs.mistral.ai/api",
    contextWindow: 128_000,
    models: [{ id: "mistral-large-latest", label: "Mistral Large" }, { id: "mistral-small-latest", label: "Mistral Small" }],
  },
  {
    providerId: "openrouter",
    label: "OpenRouter",
    description: "Use models through your OpenRouter account. Availability and billing depend on the selected upstream provider.",
    authLabel: "OpenRouter API key",
    documentation: "https://openrouter.ai/docs/quickstart",
    contextWindow: 128_000,
    models: [{ id: "openai/gpt-4.1", label: "GPT-4.1" }, { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6" }],
  },
  {
    providerId: "nvidia",
    label: "NVIDIA",
    description: "Use hosted NVIDIA API Catalog models with an NVIDIA API key.",
    authLabel: "NVIDIA NIM API key",
    documentation: "https://docs.api.nvidia.com/nim/reference/meta-llama-3_3-70b-instruct",
    contextWindow: 128_000,
    models: [{ id: "meta/llama-3.3-70b-instruct", label: "Llama 3.3 70B" }],
  },
  {
    providerId: "siliconflow",
    label: "SiliconFlow",
    description: "Use open models through SiliconFlow's international API.",
    authLabel: "SiliconFlow API key",
    documentation: "https://docs.siliconflow.com/en/userguide/quickstart",
    contextWindow: 32_000,
    models: [{ id: "Qwen/Qwen2.5-72B-Instruct", label: "Qwen2.5 72B Instruct" }],
  },
  {
    providerId: "cohere",
    label: "Cohere",
    description: "Use Command models through Cohere's OpenAI-compatible API.",
    authLabel: "Cohere API key",
    documentation: "https://docs.cohere.com/docs/compatibility-api",
    contextWindow: 256_000,
    models: [{ id: "command-a-03-2025", label: "Command A" }],
  },
] as const;

export type AdditionalNativeProviderId = (typeof additionalNativeProviderCatalog)[number]["providerId"];

/** Endpoint metadata is public; the key is read directly from an uncontrolled input. */
export function providerEndpointSetup(providerId: string) {
  return providerId === "alibaba" ? {
    defaultValue: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    placeholder: "https://YOUR-WORKSPACE.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    description: "Paste your Model Studio endpoint. The API key must belong to the same region and workspace.",
  } : undefined;
}

export function additionalModelCapabilities(providerId: string, modelId: string): ModelCapabilities | undefined {
  const provider = additionalNativeProviderCatalog.find(entry => entry.providerId === providerId);
  if (!provider?.models.some(model => model.id === modelId)) return undefined;
  return {
    contextWindow: provider.contextWindow,
    maxOutputTokens: 4_096,
    streaming: true,
    tools: true,
    vision: false,
    reasoning: false,
    structuredOutput: false,
  };
}

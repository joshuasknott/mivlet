/**
 * Fixture/preview catalogs for the agent-runtime backends.
 *
 * This is the *data* side of the logic/data split — static catalogs only. It
 * contains no credentials, live API responses, transport code, or user
 * secrets. Adapter *logic* (capability resolution, transport description)
 * lives in `codex.ts` / `acp.ts` / `copilot.ts`.
 *
 * Compliance constraints baked into these fixtures:
 *   - No claim that any tier includes Grok Build (entitlement detected
 *     post-login only).
 *   - Claude and Gemini are surfaced only as direct API-key native providers.
 *   - Install hints name a user-installed CLI; nothing is redistributed.
 */

export interface BackendFixtureModel {
  id: string;
  label: string;
}

export interface CodexFixture {
  label: string;
  description: string;
  installHint: string;
  models: BackendFixtureModel[];
}

export type AcpProviderId =
  | "cursor"
  | "copilot"
  | "grok"
  | "opencode"
  | "kimi"
  | "mistral-vibe";

export interface AcpFixture {
  providerId: AcpProviderId;
  label: string;
  description: string;
  installHint: string;
  models: BackendFixtureModel[];
}

export const codexFixtures: CodexFixture = {
  label: "Codex",
  description:
    "Continue with ChatGPT/Codex. Reaches your subscription through the Codex app-server; also supports an OpenAI API key.",
  installHint: "Requires the Codex CLI. Install it, then connect.",
  models: [
    { id: "gpt-5", label: "GPT-5" },
    { id: "gpt-5-thinking", label: "GPT-5 Thinking" },
    { id: "gpt-4.1", label: "GPT-4.1" }
  ]
};

export const acpFixtures: AcpFixture[] = [
  {
    providerId: "cursor",
    label: "Cursor",
    description:
      "Reaches your Cursor subscription over ACP (stdio/JSON-RPC) using your installed Cursor CLI.",
    installHint: "Requires the Cursor CLI. Install it, then connect.",
    models: [{ id: "cursor-default", label: "Cursor default" }]
  },
  {
    providerId: "copilot",
    label: "GitHub Copilot",
    description:
      "Reaches Copilot over ACP using the installed GitHub Copilot CLI and its existing login or token configuration.",
    installHint: "Requires GitHub Copilot CLI. Install it and run copilot login.",
    models: [{ id: "copilot-default", label: "Copilot default" }]
  },
  {
    providerId: "grok",
    label: "Grok Build",
    description:
      "Reaches your Grok account over ACP (stdio/JSON-RPC) using your installed Grok CLI. Entitlements are checked after login.",
    installHint: "Requires the Grok CLI. Install it, then connect.",
    // Note: no tier claims. Grok Build entitlement is resolved post-login only.
    models: [{ id: "grok-default", label: "Grok" }]
  },
  {
    providerId: "opencode",
    label: "OpenCode",
    description:
      "Uses your installed OpenCode agent over ACP, including the providers and models already configured in OpenCode.",
    installHint: "Requires the OpenCode CLI. Install it and configure at least one provider.",
    models: [{ id: "opencode-default", label: "OpenCode default" }]
  },
  {
    providerId: "kimi",
    label: "Kimi Code",
    description:
      "Uses your Kimi Code subscription through the official Kimi ACP runtime and its provider-owned device login.",
    installHint: "Requires Kimi Code CLI. Install it and run kimi login.",
    models: [{ id: "kimi-default", label: "Kimi default" }]
  },
  {
    providerId: "mistral-vibe",
    label: "Mistral Vibe",
    description:
      "Uses your configured Mistral Vibe account or API profile through the official Vibe ACP runtime.",
    installHint: "Requires Mistral Vibe. Install it and run vibe --setup.",
    models: [{ id: "mistral-vibe-default", label: "Vibe default" }]
  }
];

export type NativeProviderId =
  | "openai"
  | "anthropic"
  | "gemini"
  | "xai"
  | "openrouter"
  | "deepseek"
  | "zai"
  | "minimax"
  | "alibaba"
  | "fireworks"
  | "huggingface"
  | "moonshot"
  | "kimi-code"
  | "mistral"
  | "meta"
  | "perplexity"
  | "tencent"
  | "xiaomi"
  | "groq"
  | "together"
  | "cerebras"
  | "custom";

export interface NativeFixture {
  providerId: NativeProviderId;
  label: string;
  description: string;
  authLabel: string;
  models: BackendFixtureModel[];
}

/**
 * Native API provider catalogs — the providers Fable reaches directly over
 * HTTP/SSE, owning the entire agent loop. Compliance baked into copy:
 *   - Anthropic: direct API key only; no Claude.ai subscription, Vertex AI, or
 *     Amazon Bedrock route is presented as live.
 *   - Gemini: direct Google AI API key only; no Google AI Pro/Ultra subscription
 *     reuse and no Vertex AI route is presented as live.
 *   - xAI/Grok: never assert any entitlement (carried over from goal 1).
 */
export const nativeFixtures: NativeFixture[] = [
  {
    providerId: "openai",
    label: "OpenAI",
    description:
      "Reach GPT models directly with an OpenAI API key. Fable owns the agent loop, tool dispatch, and approvals.",
    authLabel: "OpenAI API key",
    models: [
      { id: "gpt-5.2", label: "GPT-5.2" },
      { id: "gpt-5", label: "GPT-5" },
      { id: "gpt-4.1", label: "GPT-4.1" }
    ]
  },
  {
    providerId: "anthropic",
    label: "Anthropic",
    description:
      "Reach Claude via an Anthropic API key. Fable owns the agent loop.",
    authLabel: "Anthropic API key",
    models: [
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "claude-opus-4-8", label: "Claude Opus 4.8" }
    ]
  },
  {
    providerId: "gemini",
    label: "Gemini",
    description:
      "Reach Gemini via a Google AI API key. Fable owns the agent loop.",
    authLabel: "Google AI API key",
    models: [
      { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }
    ]
  },
  {
    providerId: "xai",
    label: "xAI",
    description:
      "Reach Grok models directly with an xAI API key. Fable owns the agent loop, tool dispatch, and approvals.",
    authLabel: "xAI API key",
    models: [{ id: "grok-4", label: "Grok 4" }]
  },
  {
    providerId: "openrouter",
    label: "OpenRouter",
    description:
      "Reach many models through OpenRouter with an OpenRouter API key. Fable owns the agent loop.",
    authLabel: "OpenRouter API key",
    models: [{ id: "openrouter/auto", label: "OpenRouter Auto" }]
  },
  {
    providerId: "deepseek",
    label: "DeepSeek",
    description: "Reach DeepSeek models directly with a DeepSeek API key.",
    authLabel: "DeepSeek API key",
    models: [
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }
    ]
  },
  {
    providerId: "zai",
    label: "Z.AI",
    description: "Reach GLM models through the general Z.AI API.",
    authLabel: "Z.AI API key",
    models: [{ id: "glm-5.1", label: "GLM-5.1" }]
  },
  {
    providerId: "minimax",
    label: "MiniMax",
    description: "Reach MiniMax text and coding models with a MiniMax API key.",
    authLabel: "MiniMax API key",
    models: [
      { id: "MiniMax-M2.7", label: "MiniMax M2.7" },
      { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed" }
    ]
  },
  {
    providerId: "alibaba",
    label: "Alibaba Cloud",
    description: "Reach Qwen models through Alibaba Cloud Model Studio's international API.",
    authLabel: "Alibaba Cloud Model Studio API key",
    models: [{ id: "qwen3.7-plus", label: "Qwen 3.7 Plus" }]
  },
  {
    providerId: "fireworks",
    label: "Fireworks AI",
    description: "Reach serverless and deployed models through Fireworks AI.",
    authLabel: "Fireworks AI API key",
    models: [
      { id: "accounts/fireworks/models/deepseek-v3p1", label: "DeepSeek V3.1" }
    ]
  },
  {
    providerId: "huggingface",
    label: "Hugging Face",
    description: "Reach models routed by Hugging Face Inference Providers.",
    authLabel: "Hugging Face token",
    models: []
  },
  {
    providerId: "moonshot",
    label: "Moonshot AI",
    description: "Reach Kimi models through the Moonshot AI platform API.",
    authLabel: "Moonshot API key",
    models: [{ id: "kimi-k2.6", label: "Kimi K2.6" }]
  },
  {
    providerId: "kimi-code",
    label: "Kimi Code",
    description:
      "Use a Kimi Code membership API key through Kimi's official coding endpoint.",
    authLabel: "Kimi Code membership API key",
    models: [{ id: "kimi-for-coding", label: "Kimi for Coding" }]
  },
  {
    providerId: "mistral",
    label: "Mistral AI",
    description: "Reach Mistral models directly with a Mistral API key.",
    authLabel: "Mistral API key",
    models: []
  },
  {
    providerId: "meta",
    label: "Meta Llama",
    description: "Reach models available to your Meta Llama API account.",
    authLabel: "Meta Llama API key",
    models: []
  },
  {
    providerId: "perplexity",
    label: "Perplexity",
    description: "Reach Perplexity Sonar through its OpenAI-compatible API.",
    authLabel: "Perplexity API key",
    models: [{ id: "sonar", label: "Sonar" }]
  },
  {
    providerId: "tencent",
    label: "Tencent TokenHub",
    description: "Reach models through Tencent TokenHub's international endpoint.",
    authLabel: "Tencent TokenHub API key",
    models: [{ id: "hy3", label: "Hy3" }]
  },
  {
    providerId: "xiaomi",
    label: "Xiaomi MiMo",
    description: "Reach MiMo models through Xiaomi's API platform.",
    authLabel: "Xiaomi MiMo API key",
    models: [{ id: "mimo-v2.5-pro", label: "MiMo V2.5 Pro" }]
  },
  {
    providerId: "groq",
    label: "Groq",
    description: "Reach supported models through Groq's low-latency inference API.",
    authLabel: "Groq API key",
    models: [{ id: "openai/gpt-oss-120b", label: "GPT OSS 120B" }]
  },
  {
    providerId: "together",
    label: "Together AI",
    description: "Reach open and partner models through Together AI.",
    authLabel: "Together AI API key",
    models: [{ id: "openai/gpt-oss-20b", label: "GPT OSS 20B" }]
  },
  {
    providerId: "cerebras",
    label: "Cerebras",
    description: "Reach supported models through Cerebras Inference.",
    authLabel: "Cerebras API key",
    models: [{ id: "gpt-oss-120b", label: "GPT OSS 120B" }]
  },
  {
    providerId: "custom",
    label: "Custom provider",
    description: "Connect an OpenAI-compatible base URL and model ID with an optional API key.",
    authLabel: "Custom endpoint",
    models: []
  }
];

export interface BackendCatalogModel {
  id: string;
  label: string;
}

export interface CodexCatalogEntry {
  label: string;
  description: string;
  installHint: string;
  models: BackendCatalogModel[];
}

export type NativeProviderId =
  | "openai"
  | "anthropic"
  | "gemini"
  | "xai"
  | "custom";

export interface NativeProviderCatalogEntry {
  providerId: NativeProviderId;
  label: string;
  description: string;
  authLabel: string;
  models: BackendCatalogModel[];
}

export const codexCatalog: CodexCatalogEntry = {
  label: "OpenAI / ChatGPT",
  description: "Continue with ChatGPT through the official Codex browser sign-in flow.",
  installHint: "Requires the official Codex desktop app components.",
  models: [
    { id: "gpt-5", label: "GPT-5" },
    { id: "gpt-4.1", label: "GPT-4.1" }
  ]
};

export const nativeProviderCatalog: NativeProviderCatalogEntry[] = [
  {
    providerId: "openai",
    label: "OpenAI API",
    description: "Connect an OpenAI API key for direct model access.",
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
    description: "Connect an Anthropic API key for direct Claude access.",
    authLabel: "Anthropic API key",
    models: [
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "claude-opus-4-8", label: "Claude Opus 4.8" }
    ]
  },
  {
    providerId: "gemini",
    label: "Google Gemini",
    description: "Connect a Google AI API key for direct Gemini access.",
    authLabel: "Google AI API key",
    models: [
      { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }
    ]
  },
  {
    providerId: "xai",
    label: "xAI",
    description: "Connect an xAI API key for direct Grok access.",
    authLabel: "xAI API key",
    models: [{ id: "grok-4", label: "Grok 4" }]
  },
  {
    providerId: "custom",
    label: "Custom provider",
    description: "Connect one explicit OpenAI-compatible endpoint and model ID.",
    authLabel: "Custom endpoint",
    models: []
  }
];

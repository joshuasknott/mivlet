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

export type ManagedProviderId = "claude" | "cursor" | "grok" | "opencode";

export interface ManagedProviderCatalogEntry {
  providerId: ManagedProviderId;
  backendType: "claude-agent" | "cursor-acp" | "grok-acp" | "opencode-server";
  driverKind: "claude-agent" | "cursor-acp" | "grok-acp" | "opencode";
  label: string;
  description: string;
  setupLabel: string;
  setupDescription: string;
  installHint: string;
  models: BackendCatalogModel[];
}

export type NativeProviderId = "openai" | "anthropic" | "xai" | "custom";

export interface NativeProviderCatalogEntry {
  providerId: NativeProviderId;
  label: string;
  description: string;
  authLabel: string;
  models: BackendCatalogModel[];
}

export const codexCatalog: CodexCatalogEntry = {
  label: "OpenAI / ChatGPT",
  description:
    "Continue with ChatGPT through the official Codex browser sign-in flow.",
  installHint: "Requires the official Codex desktop app components.",
  models: [
    { id: "gpt-5", label: "GPT-5" },
    { id: "gpt-4.1", label: "GPT-4.1" },
  ],
};

export const managedProviderCatalog: ManagedProviderCatalogEntry[] = [
  {
    providerId: "claude",
    backendType: "claude-agent",
    driverKind: "claude-agent",
    label: "Claude",
    description:
      "Use Claude through Anthropic's official Claude Agent runtime.",
    setupLabel: "Claude account",
    setupDescription:
      "Sign in with the official Claude runtime; Fable never handles the session token.",
    installHint:
      "Install the official Claude runtime to continue with a Claude account.",
    models: [
      { id: "sonnet", label: "Claude Sonnet" },
      { id: "opus", label: "Claude Opus" },
      { id: "haiku", label: "Claude Haiku" },
    ],
  },
  {
    providerId: "cursor",
    backendType: "cursor-acp",
    driverKind: "cursor-acp",
    label: "Cursor",
    description:
      "Use your Cursor account through Cursor's official ACP runtime.",
    setupLabel: "Cursor account",
    setupDescription: "Sign in through Cursor's official agent runtime.",
    installHint:
      "Install the official Cursor Agent CLI to continue with a Cursor account.",
    models: [{ id: "default", label: "Cursor default" }],
  },
  {
    providerId: "grok",
    backendType: "grok-acp",
    driverKind: "grok-acp",
    label: "Grok",
    description: "Use your xAI account through the official Grok ACP runtime.",
    setupLabel: "Grok account",
    setupDescription: "Sign in through xAI's official Grok runtime.",
    installHint:
      "Install the official Grok runtime to continue with a Grok account. An xAI API key remains available as an advanced route.",
    models: [{ id: "grok-build", label: "Grok default" }],
  },
  {
    providerId: "opencode",
    backendType: "opencode-server",
    driverKind: "opencode",
    label: "OpenCode",
    description:
      "Use providers already configured in your local OpenCode runtime.",
    setupLabel: "OpenCode",
    setupDescription: "Connect through your local OpenCode configuration.",
    installHint:
      "Install OpenCode and configure a provider with `opencode auth login`.",
    models: [],
  },
];

export const nativeProviderCatalog: NativeProviderCatalogEntry[] = [
  {
    providerId: "openai",
    label: "OpenAI API",
    description: "Connect an OpenAI API key for direct model access.",
    authLabel: "OpenAI API key",
    models: [
      { id: "gpt-5.2", label: "GPT-5.2" },
      { id: "gpt-5", label: "GPT-5" },
      { id: "gpt-4.1", label: "GPT-4.1" },
    ],
  },
  {
    providerId: "anthropic",
    label: "Anthropic",
    description: "Connect an Anthropic API key for direct Claude access.",
    authLabel: "Anthropic API key",
    models: [
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
    ],
  },
  {
    providerId: "xai",
    label: "xAI",
    description: "Connect an xAI API key for direct Grok access.",
    authLabel: "xAI API key",
    models: [{ id: "grok-4", label: "Grok 4" }],
  },
  {
    providerId: "custom",
    label: "Custom provider",
    description:
      "Connect one explicit OpenAI-compatible endpoint and model ID.",
    authLabel: "Custom endpoint",
    models: [],
  },
];

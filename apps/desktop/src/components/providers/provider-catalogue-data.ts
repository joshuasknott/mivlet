import type { BackendProvider } from "@mivlet/protocol";
import { enabledMivletProviders } from "../../lib/provider-availability";

export type ProviderConnectionMethodKind =
  | "api-key"
  | "oauth-browser"
  | "provider-cli"
  | "custom";

export interface ProviderConnectionMethod {
  id: string;
  kind: ProviderConnectionMethodKind;
  label: string;
  description: string;
  provider: BackendProvider;
}

export interface ProviderFamily {
  id: string;
  label: string;
  iconProvider: string;
  aliases: string[];
  providers: BackendProvider[];
  methods: ProviderConnectionMethod[];
}

interface ProviderFamilyMetadata {
  label: string;
  iconProvider: string;
  aliases: string[];
}

const FAMILY_METADATA: Record<string, ProviderFamilyMetadata> = {
  openai: {
    label: "ChatGPT",
    iconProvider: "openai",
    aliases: ["OpenAI", "ChatGPT", "Codex", "GPT"],
  },
  anthropic: {
    label: "Claude",
    iconProvider: "anthropic",
    aliases: ["Anthropic", "Claude"],
  },
  antigravity: {
    label: "Antigravity",
    iconProvider: "antigravity",
    aliases: ["Google", "Gemini", "Antigravity"],
  },
  xai: {
    label: "Grok",
    iconProvider: "xai",
    aliases: ["xAI", "Grok", "Grok Build"],
  },
  alibaba: {
    label: "Qwen",
    iconProvider: "alibaba",
    aliases: ["Qwen", "Alibaba", "DashScope", "Model Studio"],
  },
  moonshot: {
    label: "Kimi",
    iconProvider: "moonshot",
    aliases: ["Moonshot", "Kimi"],
  },
  zai: {
    label: "Z.ai",
    iconProvider: "zai",
    aliases: ["Z.ai", "Zhipu", "GLM"],
  },
  custom: {
    label: "Custom provider",
    iconProvider: "custom",
    aliases: ["Custom", "Other", "OpenAI compatible", "Base URL"],
  },
  cursor: {
    label: "Cursor",
    iconProvider: "cursor",
    aliases: ["Cursor", "Anysphere", "ACP"],
  },
  opencode: {
    label: "OpenCode",
    iconProvider: "opencode",
    aliases: ["OpenCode", "local agent", "server"],
  },
};

const METHOD_KIND_PRIORITY: Record<ProviderConnectionMethodKind, number> = {
  "oauth-browser": 0,
  "provider-cli": 1,
  "api-key": 2,
  custom: 3,
};

function compactProviderId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function providerFamilyIdFor(providerId: string): string {
  const compact = compactProviderId(providerId);
  if (["openai", "chatgpt", "codex"].includes(compact)) return "openai";
  if (["xai", "grok"].includes(compact)) return "xai";
  if (["antigravity", "gemini", "google", "googleai"].includes(compact))
    return "antigravity";
  if (["anthropic", "claude"].includes(compact)) return "anthropic";
  if (compact === "cursor") return "cursor";
  if (compact === "opencode") return "opencode";
  if (
    compact.startsWith("custom") ||
    compact.startsWith("openaicompatible") ||
    compact === "other"
  ) {
    return "custom";
  }
  return providerId.toLowerCase();
}

function providerOwnedMethods(
  provider: BackendProvider,
): ProviderConnectionMethod[] {
  const setup =
    provider.setup ??
    (provider.backendType === "codex-app-server"
      ? {
          kind: "browser" as const,
          label: "ChatGPT account",
          description:
            "Sign in through the official browser flow managed by Codex.",
          recommended: true,
        }
      : provider.backendType === "antigravity-acp"
        ? {
            kind: "browser" as const,
            label: "Google account",
            description:
              "Sign in through Google's official Antigravity browser flow.",
            recommended: true,
          }
        : null);
  if (!setup || (setup.kind !== "browser" && setup.kind !== "provider-cli"))
    return [];
  return [
    {
      id: `${provider.id}:${setup.kind}`,
      kind: setup.kind === "browser" ? "oauth-browser" : "provider-cli",
      label: setup.label,
      description: setup.description,
      provider,
    },
  ];
}

function connectionMethodsForProvider(
  provider: BackendProvider,
): ProviderConnectionMethod[] {
  const familyId = providerFamilyIdFor(provider.id);
  if (familyId === "custom") {
    return [
      {
        id: `${provider.id}:custom`,
        kind: "custom",
        label: "OpenAI-compatible endpoint",
        description: "Use a custom base URL, model ID, and optional API key.",
        provider,
      },
    ];
  }

  if (provider.backendType !== "native-api") {
    return providerOwnedMethods(provider);
  }

  return [
    {
      id: `${provider.id}:api-key`,
      kind: "api-key",
      label: `${provider.label} API key`,
      description:
        familyId === "openai"
          ? "Connect an OpenAI developer account. Billed separately."
          : "Connect using a key from your provider.",
      provider,
    },
  ];
}

export function buildProviderFamilies(
  providers: BackendProvider[],
): ProviderFamily[] {
  const grouped = new Map<string, BackendProvider[]>();
  for (const provider of enabledMivletProviders(providers)) {
    const familyId = providerFamilyIdFor(provider.id);
    grouped.set(familyId, [...(grouped.get(familyId) ?? []), provider]);
  }

  return Array.from(grouped, ([id, familyProviders]) => {
    const metadata = FAMILY_METADATA[id];
    const first = familyProviders[0];
    const methods = familyProviders
      .flatMap(connectionMethodsForProvider)
      .sort((a, b) => {
        const kindDifference =
          METHOD_KIND_PRIORITY[a.kind] - METHOD_KIND_PRIORITY[b.kind];
        return kindDifference || a.label.localeCompare(b.label);
      });
    return {
      id,
      label: metadata?.label ?? first.label,
      iconProvider: metadata?.iconProvider ?? first.id,
      aliases: metadata?.aliases ?? [first.label, first.id],
      providers: familyProviders,
      methods,
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
}

export function encodeCustomProviderSecret(
  baseUrl: string,
  apiKey: string,
  modelId: string,
): string {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Use an http:// or https:// base URL.");
  }
  const normalizedBaseUrl = parsed.toString().replace(/\/$/, "");
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) {
    throw new Error("Enter the model ID used by this endpoint.");
  }
  return JSON.stringify({
    version: 1,
    kind: "openai-compatible",
    baseUrl: normalizedBaseUrl,
    modelId: normalizedModelId,
    ...(apiKey ? { apiKey } : {}),
  });
}

export function isProviderConnected(
  provider: BackendProvider,
  connectedBackendIds: string[],
): boolean {
  return (
    connectedBackendIds.includes(provider.id) ||
    provider.authState === "connected" ||
    provider.authState === "ready"
  );
}

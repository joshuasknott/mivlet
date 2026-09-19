import {
  getRuntimeAdapter,
  hasNativeRuntimeAdapter,
} from "../../runtime/adapters/select";
import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { Browser } from "@phosphor-icons/react/dist/csr/Browser";
import { CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Globe } from "@phosphor-icons/react/dist/csr/Globe";
import { Key } from "@phosphor-icons/react/dist/csr/Key";
import { Spinner } from "@phosphor-icons/react/dist/csr/Spinner";
import { TerminalWindow } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { Eye } from "@phosphor-icons/react/dist/csr/Eye";
import { EyeSlash } from "@phosphor-icons/react/dist/csr/EyeSlash";
import { LockKey } from "@phosphor-icons/react/dist/csr/LockKey";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BackendProvider, BackendVerifyResult } from "@mivlet/protocol";
import { connectResultCopy, stateViewFor } from "../../lib/backend-state";
import { enabledMivletProviders } from "../../lib/provider-availability";
import { ProviderIcon } from "../ProviderIcon";
import { GrokBotPanel } from "./GrokBotPanel";
import { grokBotConnection } from "@mivlet/connectors/remote-bots/grok-bot";
import {
  additionalNativeProviderCatalog,
  providerEndpointSetup,
} from "@mivlet/connectors/backends/additional-native";

type ProviderConnectionMethodKind =
  "api-key" | "oauth-browser" | "provider-cli" | "custom";

interface ProviderConnectionMethod {
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

function isProviderConnected(
  provider: BackendProvider,
  connectedBackendIds: string[],
): boolean {
  return (
    connectedBackendIds.includes(provider.id) ||
    provider.authState === "connected" ||
    provider.authState === "ready"
  );
}

export interface ProviderCatalogueProps {
  onboarding?: boolean;
  providers: BackendProvider[];
  connectedBackendIds: string[];
  onConnect: (
    providerId: string,
    secret: string,
  ) => Promise<BackendVerifyResult>;
  onDisconnect?: (providerId: string) => void | Promise<void>;
  onRefreshModels?: (providerId: string) => void | Promise<void>;
  onCheckConnection?: (
    providerId: string,
  ) => BackendVerifyResult | void | Promise<BackendVerifyResult | void>;
  onStartBrowserLogin?: (providerId: string) => Promise<BackendVerifyResult>;
  onStatus?: (message: string) => void;
}

export function ProviderCatalogue({
  onboarding = false,
  providers,
  connectedBackendIds,
  onConnect,
  onDisconnect,
  onRefreshModels,
  onCheckConnection,
  onStartBrowserLogin,
  onStatus,
}: ProviderCatalogueProps) {
  const families = useMemo(
    () =>
      buildProviderFamilies(providers).filter(
        (family) => !["custom", "siliconflow", "together"].includes(family.id),
      ),
    [providers],
  );
  const [selectedFamilyId, setSelectedFamilyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const lastProvider = useRef<string | null>(null);
  const catalogueRef = useRef<HTMLDivElement>(null);
  const selectedFamily = families.find(
    (family) => family.id === selectedFamilyId,
  );
  const filtered = families.filter((family) =>
    [family.label, ...family.aliases].some((value) =>
      value.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );
  const initialCount = onboarding ? 9 : 6;
  const preferred = [
    "openai",
    "anthropic",
    "antigravity",
    "deepseek",
    "openrouter",
    "mistral",
    "groq",
    "moonshot",
    "zai",
  ];
  const ordered = onboarding
    ? [...filtered].sort((a, b) => {
        const rank = (id: string) =>
          preferred.includes(id) ? preferred.indexOf(id) : preferred.length;
        return rank(a.id) - rank(b.id);
      })
    : filtered;
  const visible =
    query.trim() || showAll ? ordered : ordered.slice(0, initialCount);
  const connectedCount = families.filter((family) =>
    family.providers.some((provider) =>
      isProviderConnected(provider, connectedBackendIds),
    ),
  ).length;
  useLayoutEffect(() => {
    if (!selectedFamilyId && lastProvider.current) {
      catalogueRef.current
        ?.querySelector<HTMLButtonElement>(
          `[data-provider-family-id="${lastProvider.current}"]`,
        )
        ?.focus();
    }
  }, [selectedFamilyId]);

  return (
    <div
      className={`provider-catalogue${onboarding ? " provider-catalogue--onboarding" : ""}`}
      ref={catalogueRef}
    >
      {selectedFamily ? (
        <ProviderConnectionFlow
          key={selectedFamily.id}
          onboarding={onboarding}
          family={selectedFamily}
          connectedBackendIds={connectedBackendIds}
          onClose={() => setSelectedFamilyId(null)}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
          onRefreshModels={onRefreshModels}
          onCheckConnection={onCheckConnection}
          onStartBrowserLogin={onStartBrowserLogin}
          onStatus={onStatus}
        />
      ) : (
        <>
          <header className="provider-catalogue__header">
            <h2>{onboarding ? "Choose your AI" : "Providers"}</h2>
            {!onboarding && <p>Connect the AI you want to work with.</p>}
          </header>
          {!onboarding && (
            <p className="provider-catalogue__status">
              {connectedCount
                ? `${connectedCount} provider${connectedCount === 1 ? "" : "s"} connected`
                : "No providers connected"}
            </p>
          )}
          {(!onboarding || showAll) && (
            <label className="provider-catalogue__search">
              <MagnifyingGlass size={20} aria-hidden="true" />
              <input
                type="search"
                aria-label="Find a provider"
                placeholder="Find a provider"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          )}
          <div className="provider-catalogue__list" aria-label="All providers">
            {visible.map((family) => {
              const connected = family.providers.some((provider) =>
                isProviderConnected(provider, connectedBackendIds),
              );
              const hasAccount = family.methods.some(
                (method) => method.kind === "oauth-browser",
              );
              const hasKey = family.methods.some(
                (method) => method.kind === "api-key",
              );
              const summary =
                hasAccount && hasKey
                  ? "Account or API key"
                  : hasAccount
                    ? "Account sign-in"
                    : hasKey
                      ? "API key"
                      : "Local connection";
              return (
                <button
                  key={family.id}
                  type="button"
                  className="provider-catalogue-item"
                  data-provider-family-id={family.id}
                  aria-label={
                    connected ? `${family.label}, Connected` : family.label
                  }
                  onClick={() => {
                    lastProvider.current = family.id;
                    setSelectedFamilyId(family.id);
                  }}
                >
                  <span
                    className="provider-catalogue-item__logo"
                    aria-hidden="true"
                  >
                    <ProviderIcon
                      provider={family.iconProvider}
                      size={onboarding ? 54 : 30}
                    />
                  </span>
                  <span className="provider-catalogue-item__text">
                    <strong>{family.label}</strong>
                    {!onboarding && <small>{summary}</small>}
                  </span>
                  {connected ? (
                    <small className="provider-catalogue-item__connected">
                      Connected
                    </small>
                  ) : null}
                  {!onboarding && <CaretRight size={18} aria-hidden="true" />}
                </button>
              );
            })}
          </div>
          {!filtered.length ? (
            <p role="status">
              {families.length
                ? "No providers match your search."
                : "No model providers are registered in this build."}
            </p>
          ) : null}
          {!query.trim() && families.length > initialCount ? (
            <button
              className="provider-catalogue__more"
              onClick={() => setShowAll(!showAll)}
            >
              {showAll
                ? "Show fewer providers"
                : onboarding
                  ? "More providers"
                  : "Show all providers"}
            </button>
          ) : null}
          {!onboarding && (
            <p className="provider-security-note">
              <LockKey size={18} aria-hidden="true" />
              Your credentials stay on this device.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function ProviderMethodIcon({ kind }: { kind: ProviderConnectionMethodKind }) {
  switch (kind) {
    case "api-key":
      return <Key size={20} />;
    case "oauth-browser":
      return <Browser size={20} />;
    case "provider-cli":
      return <TerminalWindow size={20} />;
    case "custom":
      return <Globe size={20} />;
    default:
      return <Key size={20} />;
  }
}

function ProviderConnectionFlow({
  onboarding,
  family,
  connectedBackendIds,
  onClose,
  onConnect,
  onDisconnect,
  onRefreshModels,
  onCheckConnection,
  onStartBrowserLogin,
  onStatus,
}: {
  onboarding: boolean;
  family: ProviderFamily;
  connectedBackendIds: string[];
  onClose: () => void;
  onConnect: (
    providerId: string,
    secret: string,
  ) => Promise<BackendVerifyResult>;
  onDisconnect?: (providerId: string) => void | Promise<void>;
  onRefreshModels?: (providerId: string) => void | Promise<void>;
  onCheckConnection?: (
    providerId: string,
  ) => BackendVerifyResult | void | Promise<BackendVerifyResult | void>;
  onStartBrowserLogin?: (providerId: string) => Promise<BackendVerifyResult>;
  onStatus?: (message: string) => void;
}) {
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(null);
  const [remoteBotOpen, setRemoteBotOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [locallyReady, setLocallyReady] = useState<string | null>(null);
  const [locallyConfigured, setLocallyConfigured] = useState<string | null>(
    null,
  );
  const [locallyRemoved, setLocallyRemoved] = useState<string | null>(null);
  const [replacingCredential, setReplacingCredential] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [feedback, setFeedback] = useState<{
    message: string;
    tone: string;
  } | null>(null);
  const [showKey, setShowKey] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const keyInputRef = useRef<HTMLInputElement>(null);
  const customBaseUrlRef = useRef<HTMLInputElement>(null);
  const customModelRef = useRef<HTMLInputElement>(null);
  const customKeyRef = useRef<HTMLInputElement>(null);
  const providerEndpointRef = useRef<HTMLInputElement>(null);
  const selectedMethod = family.methods.find(
    (method) => method.id === selectedMethodId,
  );

  useLayoutEffect(() => {
    closeRef.current?.focus();
  }, []);
  useLayoutEffect(() => {
    closeRef.current?.focus();
    setShowKey(false);
  }, [selectedMethodId]);

  const connect = async (
    providerId: string,
    secret: string,
    clearSecret?: () => void,
  ) => {
    setPending(true);
    setFeedback(null);
    try {
      const result = await onConnect(providerId, secret);
      const copy = connectResultCopy(result.outcome, {
        detail: result.message,
      });
      setFeedback({ message: copy.message, tone: copy.tone });
      onStatus?.(copy.message);
      if (result.outcome === "ready") {
        setLocallyReady(providerId);
        setLocallyConfigured(null);
        setLocallyRemoved(null);
        setReplacingCredential(false);
      } else if (result.outcome === "configured") {
        setLocallyConfigured(providerId);
        setLocallyReady(null);
        setLocallyRemoved(null);
        setReplacingCredential(false);
      }
      return result;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not connect this provider.";
      setFeedback({ message, tone: "danger" });
      onStatus?.(message);
      return null;
    } finally {
      clearSecret?.();
      setPending(false);
    }
  };

  const methodVerifiedHere = selectedMethod
    ? locallyReady === selectedMethod.provider.id
    : false;
  const methodConfiguredHere = selectedMethod
    ? locallyConfigured === selectedMethod.provider.id
    : false;
  const methodConnected = selectedMethod
    ? locallyRemoved === selectedMethod.provider.id
      ? false
      : methodVerifiedHere ||
        methodConfiguredHere ||
        isProviderConnected(selectedMethod.provider, connectedBackendIds)
    : false;
  const methodConnectionLabel = methodVerifiedHere
    ? "Ready"
    : selectedMethod?.provider.backendType === "native-api"
      ? "Configured"
      : "Connected";
  const methodState = selectedMethod
    ? stateViewFor(selectedMethod.provider.authState)
    : null;

  const checkConnection = async (providerId: string) => {
    if (!onCheckConnection) return;
    setPending(true);
    setFeedback(null);
    try {
      const result = await onCheckConnection(providerId);
      if (result?.outcome === "ready") {
        setLocallyReady(providerId);
        setLocallyConfigured(null);
        setLocallyRemoved(null);
      } else if (result?.outcome === "configured") {
        setLocallyConfigured(providerId);
        setLocallyReady(null);
        setLocallyRemoved(null);
      } else if (result?.outcome === "auth-failed") {
        setLocallyReady(null);
        setLocallyConfigured(null);
        setLocallyRemoved(providerId);
      }
      const copy = result
        ? connectResultCopy(result.outcome, { detail: result.message })
        : { message: "Connection state refreshed.", tone: "neutral" };
      const message = copy.message;
      setFeedback({ message, tone: copy.tone });
      onStatus?.(message);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not refresh this connection.";
      setFeedback({ message, tone: "danger" });
      onStatus?.(message);
    } finally {
      setPending(false);
    }
  };

  const startBrowserLogin = async (providerId: string) => {
    if (!onStartBrowserLogin) return;
    setPending(true);
    setFeedback(null);
    try {
      const result = await onStartBrowserLogin(providerId);
      if (result.outcome === "ready") {
        setLocallyReady(providerId);
        setLocallyConfigured(null);
        setLocallyRemoved(null);
      }
      const copy = connectResultCopy(result.outcome, {
        detail: result.message,
      });
      setFeedback({ message: copy.message, tone: copy.tone });
      onStatus?.(copy.message);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Browser sign-in could not be completed.";
      setFeedback({ message, tone: "danger" });
      onStatus?.(message);
    } finally {
      setPending(false);
    }
  };

  const goBack = () => {
    if (pending) {
      onClose();
      return;
    }
    if (selectedMethodId) {
      setSelectedMethodId(null);
      setReplacingCredential(false);
      setConfirmingRemoval(false);
      setFeedback(null);
    } else onClose();
  };

  if (remoteBotOpen) return <GrokBotPanel onBack={() => setRemoteBotOpen(false)} />;

  return (
    <section
      className="provider-connection-flow"
      role="region"
      aria-label={family.label}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          goBack();
        }
      }}
    >
      <article className="provider-connection-flow__panel">
        <button
          ref={closeRef}
          type="button"
          className="provider-method-detail__back"
          onClick={goBack}
          aria-label={
            selectedMethod && !pending ? "Back to connection methods" : "Back to providers"
          }
        >
          <ArrowLeft size={18} /> {selectedMethod && !pending ? family.label : "Providers"}
        </button>
        {pending && <p role="status">You can go back while this connection finishes.</p>}
        <header className="provider-connection-flow__header">
          <span className="provider-connection-flow__logo" aria-hidden="true">
            <ProviderIcon
              provider={family.iconProvider}
              size={onboarding ? 72 : 38}
            />
          </span>
          <h2>
            {selectedMethod?.kind === "api-key" && !methodConnected
              ? "Connect with an API key"
              : `Connect ${family.label}`}
          </h2>
          {(!onboarding || selectedMethod) && (
            <p>
              {selectedMethod
                ? selectedMethod.kind === "api-key"
                  ? `Add a key from your ${selectedMethod.provider.id === "openai" ? "OpenAI" : selectedMethod.provider.label} developer account.`
                  : selectedMethod.label
                : "Choose how you’d like to connect."}
            </p>
          )}
          {selectedMethod?.kind === "api-key" && family.id === "openai" ? (
            <small>API usage is billed separately from ChatGPT.</small>
          ) : null}
        </header>

        {selectedMethod ? (
          <div className="provider-method-detail">
            {methodConnected || selectedMethod.kind !== "api-key" ? (
              <div className="provider-method-detail__heading">
                <span aria-hidden="true">
                  <ProviderMethodIcon kind={selectedMethod.kind} />
                </span>
                <div>
                  <strong>{selectedMethod.label}</strong>
                  <p>{selectedMethod.description}</p>
                </div>
                <small
                  data-tone={
                    methodConnected
                      ? selectedMethod.provider.backendType === "native-api" &&
                        !methodVerifiedHere
                        ? "info"
                        : "ready"
                      : methodState?.tone
                  }
                >
                  {methodConnected ? methodConnectionLabel : methodState?.label}
                </small>
              </div>
            ) : null}

            {selectedMethod.kind === "api-key" &&
            (!methodConnected || replacingCredential) ? (
              <form
                className="provider-method-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const secret = keyInputRef.current?.value.trim() ?? "";
                  if (!secret) {
                    setFeedback({
                      message: "Enter an API key to connect.",
                      tone: "danger",
                    });
                    return;
                  }
                  const endpoint = providerEndpointSetup(
                    selectedMethod.provider.id,
                  );
                  const credential = endpoint
                    ? JSON.stringify({
                        version: 1,
                        baseUrl:
                          providerEndpointRef.current?.value.trim() ?? "",
                        apiKey: secret,
                      })
                    : secret;
                  void connect(selectedMethod.provider.id, credential, () => {
                    if (keyInputRef.current) keyInputRef.current.value = "";
                  });
                }}
              >
                <label>
                  <span>{selectedMethod.provider.id === "openai" ? "OpenAI" : selectedMethod.provider.label} API key</span>
                  <span className="provider-key-input">
                    <input
                      ref={keyInputRef}
                      type={showKey ? "text" : "password"}
                      aria-label={`API key for ${family.label.toLowerCase()}`}
                      placeholder="Paste your API key"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={pending}
                    />
                    <button
                      type="button"
                      aria-label={showKey ? "Hide API key" : "Show API key"}
                      aria-pressed={showKey}
                      onClick={() => setShowKey(!showKey)}
                    >
                      {showKey ? <EyeSlash size={20} /> : <Eye size={20} />}
                    </button>
                  </span>
                </label>
                {family.id === "openai" ? (
                  <a
                    className="provider-key-help"
                    href="https://platform.openai.com/api-keys"
                    onClick={(event) => {
                      if (!hasNativeRuntimeAdapter()) return;
                      event.preventDefault();
                      void getRuntimeAdapter()
                        .invoke<void>("open_conversation_link", {
                          url: "https://platform.openai.com/api-keys",
                        })
                        .catch(() =>
                          setFeedback({
                            message:
                              "Could not open your browser. Visit platform.openai.com/api-keys to create a key.",
                            tone: "danger",
                          }),
                        );
                    }}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Get an API key ↗
                  </a>
                ) : null}
                <p className="provider-security-note">
                  <LockKey size={18} aria-hidden="true" />
                  Stored securely on this device.
                </p>
                {providerEndpointSetup(selectedMethod.provider.id) ? (
                  <label>
                    <span>Model Studio endpoint</span>
                    <input
                      ref={providerEndpointRef}
                      type="url"
                      aria-label="Alibaba Model Studio endpoint"
                      defaultValue={
                        providerEndpointSetup(selectedMethod.provider.id)
                          ?.defaultValue
                      }
                      placeholder={
                        providerEndpointSetup(selectedMethod.provider.id)
                          ?.placeholder
                      }
                      autoComplete="off"
                      spellCheck={false}
                      required
                      disabled={pending}
                    />
                    <small>
                      {
                        providerEndpointSetup(selectedMethod.provider.id)
                          ?.description
                      }
                    </small>
                  </label>
                ) : null}
                {additionalNativeProviderCatalog.some(
                  (entry) => entry.providerId === selectedMethod.provider.id,
                ) ? (
                  <small>
                    Connecting sends a short model request to verify access,
                    with a limit of 16 output tokens.
                  </small>
                ) : null}
                <div className="provider-method-form__actions">
                  <button
                    type="submit"
                    className="provider-method-form__primary"
                    disabled={pending}
                  >
                    {pending ? (
                      <>
                        <Spinner size={14} className="og-spinner" /> Verifying
                      </>
                    ) : replacingCredential ? (
                      "Replace key & reconnect"
                    ) : (
                      "Connect"
                    )}
                  </button>
                  <button
                    type="button"
                    className="provider-method-cancel"
                    disabled={pending}
                    onClick={() => {
                      setSelectedMethodId(null);
                      setReplacingCredential(false);
                      setFeedback(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : null}

            {selectedMethod.kind === "custom" && !methodConnected ? (
              <form
                className="provider-method-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const baseUrl = customBaseUrlRef.current?.value.trim() ?? "";
                  const modelId = customModelRef.current?.value.trim() ?? "";
                  const apiKey = customKeyRef.current?.value.trim() ?? "";
                  if (!baseUrl) {
                    setFeedback({
                      message: "Enter the provider's base URL.",
                      tone: "danger",
                    });
                    return;
                  }
                  if (!modelId) {
                    setFeedback({
                      message: "Enter the model ID used by this endpoint.",
                      tone: "danger",
                    });
                    return;
                  }
                  try {
                    const secret = encodeCustomProviderSecret(
                      baseUrl,
                      apiKey,
                      modelId,
                    );
                    void connect(selectedMethod.provider.id, secret, () => {
                      if (customKeyRef.current) customKeyRef.current.value = "";
                    });
                  } catch (error) {
                    setFeedback({
                      message:
                        error instanceof Error
                          ? error.message
                          : "Enter a valid base URL.",
                      tone: "danger",
                    });
                  }
                }}
              >
                <label>
                  <span>Base URL</span>
                  <input
                    ref={customBaseUrlRef}
                    type="url"
                    aria-label="Custom provider base URL"
                    placeholder="https://api.example.com/v1"
                    autoComplete="url"
                    disabled={pending}
                  />
                </label>
                <label>
                  <span>Model ID</span>
                  <input
                    ref={customModelRef}
                    type="text"
                    aria-label="Custom provider model ID"
                    placeholder="model-name"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={pending}
                  />
                </label>
                <label>
                  <span>
                    API key <small>Optional</small>
                  </span>
                  <input
                    ref={customKeyRef}
                    type="password"
                    aria-label="API key for custom provider"
                    placeholder="Enter a key if required"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={pending}
                  />
                </label>
                <button
                  type="submit"
                  className="provider-method-form__primary"
                  disabled={pending}
                >
                  {pending ? (
                    <>
                      <Spinner size={14} className="og-spinner" /> Connecting
                    </>
                  ) : (
                    "Connect endpoint"
                  )}
                </button>
              </form>
            ) : null}

            {selectedMethod.kind === "oauth-browser" ||
            selectedMethod.kind === "provider-cli" ? (
              <div className="provider-method-detail__instructions">
                {selectedMethod.kind === "oauth-browser" ? (
                  <Browser size={19} aria-hidden="true" />
                ) : (
                  <TerminalWindow size={19} aria-hidden="true" />
                )}
                <div>
                  <strong>
                    {selectedMethod.kind === "oauth-browser"
                      ? "Provider-supported browser sign-in"
                      : "Provider-owned local sign-in"}
                  </strong>
                  <p>
                    {selectedMethod.kind === "oauth-browser"
                      ? "Mivlet opens the official provider page and waits for the provider-owned flow to finish."
                      : "Mivlet uses the provider's official local runtime and reads only its connection state."}{" "}
                    Credentials never enter the Mivlet interface.
                  </p>
                  <p>
                    {selectedMethod.provider.installHint ??
                      "Mivlet reads the provider runtime's connection state; it never collects subscription tokens."}
                  </p>
                </div>
              </div>
            ) : null}

            {(selectedMethod.kind === "provider-cli" ||
              (selectedMethod.kind === "oauth-browser" &&
                selectedMethod.provider.id !== "antigravity")) &&
            selectedMethod.provider.authState === "install-required" &&
            onCheckConnection &&
            !methodConnected ? (
              <button
                type="button"
                className="provider-method-detail__check"
                disabled={pending}
                onClick={() => void checkConnection(selectedMethod.provider.id)}
              >
                {pending ? (
                  <>
                    <Spinner size={14} className="og-spinner" /> Checking
                  </>
                ) : (
                  `Check for ${selectedMethod.provider.label}`
                )}
              </button>
            ) : null}

            {selectedMethod.kind === "provider-cli" &&
            selectedMethod.provider.authState !== "install-required" &&
            selectedMethod.provider.authState !== "unavailable" &&
            onCheckConnection &&
            !methodConnected ? (
              <button
                type="button"
                className="provider-method-form__primary"
                disabled={pending}
                onClick={() => void checkConnection(selectedMethod.provider.id)}
              >
                {pending ? (
                  <>
                    <Spinner size={14} className="og-spinner" /> Checking
                  </>
                ) : (
                  "Check connection"
                )}
              </button>
            ) : null}

            {selectedMethod.kind === "oauth-browser" &&
            (selectedMethod.provider.authState !== "install-required" ||
              selectedMethod.provider.id === "antigravity") &&
            onStartBrowserLogin &&
            !methodConnected ? (
              <button
                type="button"
                className="provider-method-form__primary"
                disabled={pending}
                onClick={() =>
                  void startBrowserLogin(selectedMethod.provider.id)
                }
              >
                {pending ? (
                  <>
                    <Spinner size={14} className="og-spinner" /> Waiting for
                    browser
                  </>
                ) : selectedMethod.provider.id === "antigravity" ? (
                  "Continue with Google"
                ) : (
                  "Continue in browser"
                )}
              </button>
            ) : null}

            {methodConnected ? (
              <div className="provider-method-detail__connected">
                <CheckCircle size={18} weight="fill" aria-hidden="true" />
                <span>
                  {selectedMethod.provider.backendType === "native-api" &&
                  !methodVerifiedHere
                    ? "This connection is configured. A live model request is the final check."
                    : "This connection is ready."}
                </span>
                <div>
                  {onCheckConnection ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        void checkConnection(selectedMethod.provider.id)
                      }
                    >
                      {pending ? "Checking…" : "Check health"}
                    </button>
                  ) : null}
                  {onRefreshModels &&
                  selectedMethod.provider.capabilities.includes(
                    "model-availability",
                  ) ? (
                    <button
                      type="button"
                      onClick={() =>
                        void onRefreshModels(selectedMethod.provider.id)
                      }
                    >
                      Refresh models
                    </button>
                  ) : null}
                  {onDisconnect &&
                  selectedMethod.provider.backendType === "native-api" ? (
                    <button
                      type="button"
                      onClick={() => setReplacingCredential(true)}
                    >
                      Replace key
                    </button>
                  ) : null}
                  {onDisconnect && selectedMethod.provider.id !== "codex" ? (
                    <button
                      type="button"
                      onClick={() => setConfirmingRemoval(true)}
                    >
                      Remove from Mivlet
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {confirmingRemoval && selectedMethod.provider.id !== "codex" ? (
              <div
                className="provider-method-detail__removal"
                role="alertdialog"
                aria-label={`Remove ${selectedMethod.provider.label} from Mivlet`}
              >
                <strong>
                  {selectedMethod.provider.backendType === "native-api"
                    ? "Remove this key from Mivlet?"
                    : "Disconnect this provider?"}
                </strong>
                <p>
                  {selectedMethod.provider.backendType === "native-api"
                    ? "Mivlet will delete its local credential. This does not revoke the key at the provider; revoke it there too if it may be compromised."
                    : "Mivlet will remove the local Antigravity profile and its Google session from this account."}
                </p>
                <div>
                  <button
                    type="button"
                    onClick={() => setConfirmingRemoval(false)}
                  >
                    Keep provider
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setPending(true);
                      void Promise.resolve(
                        onDisconnect?.(selectedMethod.provider.id),
                      )
                        .then(() => {
                          setLocallyReady(null);
                          setLocallyConfigured(null);
                          setLocallyRemoved(selectedMethod.provider.id);
                          setReplacingCredential(false);
                          setConfirmingRemoval(false);
                          const message =
                            "Removed from Mivlet. Revoke the key at the provider too if needed.";
                          setFeedback({ message, tone: "neutral" });
                          onStatus?.(message);
                        })
                        .catch((error) => {
                          const message =
                            error instanceof Error
                              ? error.message
                              : "Could not remove this provider.";
                          setFeedback({ message, tone: "danger" });
                        })
                        .finally(() => setPending(false));
                    }}
                  >
                    {selectedMethod.provider.backendType === "native-api"
                      ? "Remove key"
                      : "Disconnect"}
                  </button>
                </div>
              </div>
            ) : null}

            {feedback ? (
              <p
                className="provider-method-detail__feedback"
                data-tone={feedback.tone}
                role={feedback.tone === "danger" ? "alert" : "status"}
              >
                {feedback.message}
              </p>
            ) : null}
          </div>
        ) : (
          <div
            className="provider-connection-methods"
            aria-label={`Connection methods for ${family.label}`}
          >
            {family.id === grokBotConnection.familyId && (
              <button type="button" className="provider-connection-method" onClick={() => setRemoteBotOpen(true)}>
                <span className="provider-connection-method__icon"><Globe size={20} /></span>
                <span><strong>{grokBotConnection.label}</strong><small>Connect a bridge to your existing remote Bots.</small></span>
                <CaretRight size={18} />
              </button>
            )}
            {family.methods.map((method) => {
              const connected = isProviderConnected(
                method.provider,
                connectedBackendIds,
              );
              const state = connected
                ? method.provider.backendType === "native-api"
                  ? { label: "Configured", tone: "info" }
                  : { label: "Connected", tone: "ready" }
                : stateViewFor(method.provider.authState);
              return (
                <button
                  key={method.id}
                  type="button"
                  className="provider-connection-method"
                  onClick={() => {
                    setSelectedMethodId(method.id);
                    setFeedback(null);
                    if (
                      onboarding &&
                      method.kind === "oauth-browser" &&
                      onStartBrowserLogin &&
                      (method.provider.authState !== "install-required" ||
                        method.provider.id === "antigravity") &&
                      !connected
                    ) {
                      void startBrowserLogin(method.provider.id);
                    }
                  }}
                >
                  <span
                    className="provider-connection-method__icon"
                    aria-hidden="true"
                  >
                    <ProviderMethodIcon kind={method.kind} />
                  </span>
                  <span>
                    <strong>
                      {method.kind === "api-key"
                        ? "Use an API key"
                        : method.provider.id === "codex"
                          ? "Sign in with ChatGPT"
                          : method.label}
                    </strong>
                    {!onboarding && (
                      <small>
                        {method.provider.id === "codex"
                          ? "Continue with your ChatGPT account in your browser."
                          : method.description}
                      </small>
                    )}
                  </span>
                  {connected ||
                  ["install-required", "unavailable"].includes(
                    method.provider.authState,
                  ) ? (
                    <span
                      className="provider-connection-method__state"
                      data-tone={state.tone}
                    >
                      {state.label}
                    </span>
                  ) : (
                    <span />
                  )}
                  <CaretRight size={16} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        )}
        {onboarding && !selectedMethod && family.id === "openai" && (
          <p className="provider-onboarding-billing">
            API usage is billed separately.
          </p>
        )}
      </article>
    </section>
  );
}

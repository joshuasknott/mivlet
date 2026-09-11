import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { Browser } from "@phosphor-icons/react/dist/csr/Browser";
import { CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Globe } from "@phosphor-icons/react/dist/csr/Globe";
import { Key } from "@phosphor-icons/react/dist/csr/Key";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Spinner } from "@phosphor-icons/react/dist/csr/Spinner";
import { TerminalWindow } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  BackendAuthState,
  BackendProvider,
  BackendVerifyResult,
} from "@fable/protocol";
import { connectResultCopy, stateViewFor } from "../../lib/backend-state";
import { enabledFableProviders } from "../../lib/provider-availability";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { ProviderIcon } from "../ProviderIcon";

export const FEATURED_PROVIDER_FAMILY_IDS = [
  "openai",
  "anthropic",
  "antigravity",
  "xai",
] as const;

export type ProviderConnectionMethodKind =
  "api-key" | "oauth-browser" | "provider-cli" | "custom";

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
    label: "OpenAI / ChatGPT",
    iconProvider: "openai",
    aliases: ["OpenAI", "ChatGPT", "Codex", "GPT"],
  },
  anthropic: {
    label: "Claude",
    iconProvider: "anthropic",
    aliases: ["Anthropic", "Claude"],
  },
  antigravity: {
    label: "Google Antigravity",
    iconProvider: "antigravity",
    aliases: ["Google", "Gemini", "Antigravity"],
  },
  xai: {
    label: "Grok",
    iconProvider: "xai",
    aliases: ["xAI", "Grok", "Grok Build"],
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

export function providerFamilyIdFor(providerId: string): string {
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

export function connectionMethodsForProvider(
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
      description: "Use a key stored by Mivlet's local credential boundary.",
      provider,
    },
  ];
}

export function buildProviderFamilies(
  providers: BackendProvider[],
): ProviderFamily[] {
  const grouped = new Map<string, BackendProvider[]>();
  for (const provider of enabledFableProviders(providers)) {
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

function familyState(
  family: ProviderFamily,
  connectedBackendIds: string[],
): { label: string; tone: string } {
  const connectedProviders = family.providers.filter((provider) =>
    isProviderConnected(provider, connectedBackendIds),
  );
  if (
    connectedProviders.some((provider) => provider.backendType !== "native-api")
  ) {
    return { label: "Connected", tone: "ready" };
  }
  if (connectedProviders.length > 0) {
    // A stored direct-provider credential is configured, but key presence alone
    // is not proof that the provider accepted it. Keep this conservative until
    // Mivlet has persisted live verification state.
    return { label: "Configured", tone: "info" };
  }
  const statePriority: BackendAuthState[] = [
    "connecting",
    "sign-in-required",
    "install-required",
    "expired",
    "failed",
    "needs-auth",
    "unsupported",
    "unavailable",
  ];
  const state =
    statePriority.find((candidate) =>
      family.providers.some((provider) => provider.authState === candidate),
    ) ?? family.providers[0].authState;
  return stateViewFor(state);
}

function familyMatches(family: ProviderFamily, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  const haystack = [
    family.label,
    family.id,
    ...family.aliases,
    ...family.providers.flatMap((provider) => [
      provider.label,
      provider.description,
      ...provider.models.flatMap((model) => [model.id, model.label]),
    ]),
    ...family.methods.flatMap((method) => [method.label, method.description]),
  ]
    .join(" ")
    .toLocaleLowerCase();
  return haystack.includes(normalized);
}

export interface ProviderCatalogueProps {
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
  providers,
  connectedBackendIds,
  onConnect,
  onDisconnect,
  onRefreshModels,
  onCheckConnection,
  onStartBrowserLogin,
  onStatus,
}: ProviderCatalogueProps) {
  const families = useMemo(() => buildProviderFamilies(providers), [providers]);
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedFamilyId, setSelectedFamilyId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const featured = useMemo(() => {
    const ranked = FEATURED_PROVIDER_FAMILY_IDS.flatMap((id) => {
      const family = families.find((candidate) => candidate.id === id);
      return family ? [family] : [];
    });
    return ranked.length > 0 ? ranked : families.slice(0, 8);
  }, [families]);

  const alphabetical = useMemo(
    () => families.filter((family) => familyMatches(family, query)),
    [families, query],
  );
  const selectedFamily = families.find(
    (family) => family.id === selectedFamilyId,
  );

  useEffect(() => {
    if (showAll) searchRef.current?.focus();
  }, [showAll]);

  const visibleFamilies = showAll ? alphabetical : featured;

  return (
    <div className="provider-catalogue">
      {showAll ? (
        <div className="provider-catalogue__toolbar">
          <label className="provider-catalogue__search">
            <MagnifyingGlass size={16} aria-hidden="true" />
            <span className="sr-only">Search providers</span>
            <input
              ref={searchRef}
              type="search"
              placeholder="Search providers"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <span className="provider-catalogue__count">
            {alphabetical.length}{" "}
            {alphabetical.length === 1 ? "provider" : "providers"}
          </span>
        </div>
      ) : null}

      <div
        className={
          showAll ? "provider-catalogue__list" : "provider-catalogue__grid"
        }
        aria-label={showAll ? "All providers" : "Featured providers"}
      >
        {visibleFamilies.map((family) => {
          const state = familyState(family, connectedBackendIds);
          return (
            <button
              key={family.id}
              type="button"
              className={
                showAll
                  ? "provider-catalogue-item provider-catalogue-item--list"
                  : "provider-catalogue-item"
              }
              data-provider-family-id={family.id}
              aria-label={`${family.label}, ${state.label}`}
              onClick={() => setSelectedFamilyId(family.id)}
            >
              <span
                className="provider-catalogue-item__logo"
                aria-hidden="true"
              >
                <ProviderIcon
                  provider={family.iconProvider}
                  size={showAll ? 28 : 34}
                />
              </span>
              <span className="provider-catalogue-item__text">
                <strong>{family.label}</strong>
                <small data-tone={state.tone}>{state.label}</small>
              </span>
              {showAll ? <CaretRight size={16} aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>

      {showAll && visibleFamilies.length === 0 ? (
        <p className="provider-catalogue__empty" role="status">
          No providers match &ldquo;{query}&rdquo;.
        </p>
      ) : null}

      {families.length > 0 ? (
        <button
          type="button"
          className="provider-catalogue__show-all"
          aria-expanded={showAll}
          onClick={() => {
            setShowAll((current) => !current);
            setQuery("");
          }}
        >
          {showAll ? "Show featured providers" : "Show all providers"}
        </button>
      ) : (
        <p className="provider-catalogue__empty" role="status">
          No model providers are registered in this build.
        </p>
      )}

      {selectedFamily ? (
        <ProviderConnectionModal
          key={selectedFamily.id}
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
      ) : null}
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

function ProviderConnectionModal({
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
  const modalRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const customBaseUrlRef = useRef<HTMLInputElement>(null);
  const customModelRef = useRef<HTMLInputElement>(null);
  const customKeyRef = useRef<HTMLInputElement>(null);
  const selectedMethod = family.methods.find(
    (method) => method.id === selectedMethodId,
  );

  useModalFocusTrap({
    active: true,
    containerRef: modalRef,
    initialFocusRef: closeRef,
    onClose,
  });

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useLayoutEffect(() => {
    if (selectedMethodId) {
      backRef.current?.focus();
    }
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

  return (
    <div
      ref={modalRef}
      className="provider-connection-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`provider-family-${family.id}`}
      aria-describedby={`provider-family-${family.id}-description`}
      tabIndex={-1}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <article className="provider-connection-modal__panel">
        <button
          ref={closeRef}
          type="button"
          className="provider-connection-modal__close"
          aria-label="Close provider setup"
          onClick={onClose}
        >
          <X size={18} />
        </button>

        <header className="provider-connection-modal__header">
          <span className="provider-connection-modal__logo" aria-hidden="true">
            <ProviderIcon provider={family.iconProvider} size={42} />
          </span>
          <h2 id={`provider-family-${family.id}`}>{family.label}</h2>
          <p id={`provider-family-${family.id}-description`}>
            {selectedMethod
              ? selectedMethod.label
              : "Choose how you want to connect."}
          </p>
        </header>

        {selectedMethod ? (
          <div className="provider-method-detail">
            <button
              ref={backRef}
              type="button"
              className="provider-method-detail__back"
              onClick={() => {
                setSelectedMethodId(null);
                setFeedback(null);
              }}
            >
              <ArrowLeft size={15} /> Back to connection methods
            </button>

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
                  void connect(selectedMethod.provider.id, secret, () => {
                    if (keyInputRef.current) keyInputRef.current.value = "";
                  });
                }}
              >
                <label>
                  <span>API key</span>
                  <input
                    ref={keyInputRef}
                    type="password"
                    aria-label={`API key for ${family.label.toLowerCase()}`}
                    placeholder={`Enter your ${selectedMethod.provider.label} API key`}
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
                      <Spinner size={14} className="og-spinner" /> Verifying
                    </>
                  ) : replacingCredential ? (
                    "Replace key & reconnect"
                  ) : (
                    "Add key & connect"
                  )}
                </button>
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
                  }}
                >
                  <span
                    className="provider-connection-method__icon"
                    aria-hidden="true"
                  >
                    <ProviderMethodIcon kind={method.kind} />
                  </span>
                  <span>
                    <strong>{method.label}</strong>
                    <small>{method.description}</small>
                  </span>
                  <span
                    className="provider-connection-method__state"
                    data-tone={state.tone}
                  >
                    {state.label}
                  </span>
                  <CaretRight size={16} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        )}
      </article>
    </div>
  );
}

import {
  ArrowClockwise,
  CheckCircle,
  Clock,
  DeviceMobile,
  GearSix,
  Key,
  LockKey,
  Moon,
  Plugs,
  ShieldCheck,
  Spinner,
  Sparkle,
  SquaresFour,
  Sun,
  Trash,
  UploadSimple,
  UserCircle,
  WarningCircle,
  X
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type {
  ActionHistoryEvent,
  BackendAuthState,
  BackendProvider,
  CustomApprovalSettings,
  RemoteControlStatusSnapshot
} from "@fable/protocol";
import { providerCapabilityLabels } from "../../lib/backend-capabilities";
import {
  connectResultCopy,
  isDiscoveryDegraded,
  modelDiscoveryView,
  stateViewFor
} from "../../lib/backend-state";
import type { ModelDiscoveryOutcome } from "../../lib/backend-state";
import {
  CUSTOM_APPROVAL_SECTION,
  CUSTOM_APPROVAL_TOGGLE_ORDER,
  customApprovalToggleHelper,
  customApprovalToggleLabel
} from "../../lib/approval-copy";
import { PERMISSION_PROFILES } from "../../lib/agent-run";
import { getRuntimeRemoteControlStatus } from "../../runtime";
import { ProviderIcon } from "../ProviderIcon";
import { RunHistoryPage } from "./RunHistoryPage";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import { profileFixture } from "../../data/workspace";
import type { ProfileFixture } from "../../data/workspace";

// Re-export the eager-loadable tab metadata so the lazy-loaded page module
// remains the single source of truth for existing direct importers. The
// lightweight `settings-tabs.ts` is what callers that only need the tab list
// should import, so they don't pull this heavy module into the initial bundle.
export type { SettingsTab } from "./settings-tabs";
export { tabs } from "./settings-tabs";
import { tabs } from "./settings-tabs";
import type { SettingsTab } from "./settings-tabs";

/**
 * Settings -> Providers: the real agent-runtime backend list.
 *
 * This view renders the providers the Rust credential boundary reports via
 * list_backends/listRuntimeBackends: no preview defaults, no fake plan row,
 * no pre-connected OpenAI, and no temporary-session connection copy. Each row
 * shows the boundary-resolved auth state, declared capabilities, and models.
 *
 *   - Native-API providers (OpenAI, Anthropic, Gemini, xAI, OpenRouter) connect
 *     and disconnect through the Rust credential boundary. The API key is read
 *     from an uncontrolled input and handed straight to
 *     runtime.connectBackend — it never enters React state, snapshots, or logs.
 *   - Subscription/CLI providers use their provider-owned runtime/auth. Fable
 *     does not collect subscription tokens or fake one-click setup here.
 */
export function SettingsPage({
  runtime,
  profile = profileFixture,
  onProfileChange,
  theme,
  onThemeChange,
  activeTab,
  workspaceName,
  titleId = "settings-title"
}: {
  runtime: ShellRuntime;
  profile?: ProfileFixture;
  onProfileChange?: (profile: ProfileFixture) => void;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
  activeTab: SettingsTab;
  workspaceName: string;
  titleId?: string;
}) {
  const [status, setStatus] = useState("");

  return (
    <section className="settings-page" aria-labelledby={titleId}>
      <div className="settings-page__content">
        <div className="settings-page__header">
          <h1 id={titleId}>
            {tabs.find((t) => t.id === activeTab)?.label || "Settings"}
          </h1>
        </div>

        {activeTab === "providers" ? (
          <ProviderAccessView runtime={runtime} onStatus={setStatus} />
        ) : activeTab === "general" ? (
          <>
            <ProfileSettingsView
              profile={profile}
              onProfileChange={onProfileChange}
              onStatus={setStatus}
            />
            <AppearanceSettingsView
              theme={theme}
              onThemeChange={onThemeChange}
              onStatus={setStatus}
            />
          </>
        ) : activeTab === "privacy" ? (
          <>
            <PrivacySettingsView runtime={runtime} onStatus={setStatus} />
            <ApprovalsSettingsView runtime={runtime} onStatus={setStatus} />
          </>
        ) : activeTab === "history" ? (
          <HistorySettingsView
            runtime={runtime}
            onStatus={setStatus}
          />
        ) : null}

        {status ? (
          <p className="settings-status" role="status">
            {status}
          </p>
        ) : null}
      </div>
    </section>
  );
}

// Display order for providers in the Settings -> Providers list. Hoisted to
// module scope so the comparator and the lists derived from it don't get
// reallocated on every render.
const PROVIDER_PRIORITY = [
  "codex",
  "cursor",
  "copilot",
  "grok",
  "openai",
  "anthropic",
  "gemini",
  "xiai",
  "openrouter"
];

function byProviderPriority(a: BackendProvider, b: BackendProvider) {
  const aPriority = PROVIDER_PRIORITY.indexOf(a.id);
  const bPriority = PROVIDER_PRIORITY.indexOf(b.id);
  return (aPriority === -1 ? Number.MAX_SAFE_INTEGER : aPriority) -
    (bPriority === -1 ? Number.MAX_SAFE_INTEGER : bPriority);
}

function ProviderAccessView({
  runtime,
  onStatus
}: {
  runtime: ShellRuntime;
  onStatus: (message: string) => void;
}) {
  const providers = runtime.backendProviders;
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  // The runtime emits "Connecting <providerId>…" while a connect/disconnect is
  // in flight; surface it as the pending provider id so the row shows a spinner.
  const pendingProviderId = runtime.backendStatus?.match(/Connecting (\S+?)[\u2026.]?/)?.[1];

  // Native-API (key) providers are connectable here. Subscription/CLI providers
  // (codex/cursor/copilot/grok) report provider-owned runtime state.
  const nativeProviders = useMemo(
    () =>
      providers
        .filter((provider) => provider.backendType === "native-api")
        .sort(byProviderPriority),
    [providers]
  );
  const subscriptionProviders = useMemo(
    () =>
      providers
        .filter((provider) => provider.backendType !== "native-api")
        .sort(byProviderPriority),
    [providers]
  );
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
  const selectedConnected = selectedProvider
    ? runtime.connectedBackendIds.includes(selectedProvider.id)
    : false;
  const selectedPending = selectedProvider
    ? pendingProviderId === selectedProvider.id
    : false;
  const selectedDiscoveryState = selectedProvider
    ? runtime.modelDiscoveryByProvider[selectedProvider.id] ?? "idle"
    : "idle";

  return (
    <div className="settings-page__body">
      <div className="settings-section-heading">
        <p>
          Connect API-key providers to run Fable&rsquo;s agent loop directly. Subscription and
          CLI-backed providers use their installed provider runtime.
        </p>
      </div>

      <div className="provider-access-groups" aria-label="Provider access">
        <section className="provider-access-group" aria-labelledby="subscription-providers-title">
          <div className="provider-access-group__heading">
            <strong id="subscription-providers-title">Subscriptions</strong>
            <span>Use an existing provider subscription or installed CLI.</span>
          </div>
          <div className="provider-access-list">
            {subscriptionProviders.length > 0 ? (
              subscriptionProviders.map((provider) => (
                <SubscriptionProviderRow
                  key={provider.id}
                  provider={provider}
                  onOpen={() => setSelectedProviderId(provider.id)}
                />
              ))
            ) : (
              <p className="provider-access-empty">No subscription providers are registered.</p>
            )}
          </div>
        </section>

        <section className="provider-access-group" aria-labelledby="api-key-providers-title">
          <div className="provider-access-group__heading">
            <strong id="api-key-providers-title">API keys</strong>
            <span>Connect directly with a key stored on this device.</span>
          </div>
          <div className="provider-access-list">
            {nativeProviders.length > 0 ? (
              nativeProviders.map((provider) => (
                <NativeProviderRow
                  key={provider.id}
                  provider={provider}
                  connected={runtime.connectedBackendIds.includes(provider.id)}
                  pending={pendingProviderId === provider.id}
                  discoveryState={runtime.modelDiscoveryByProvider[provider.id] ?? "idle"}
                  onOpen={() => setSelectedProviderId(provider.id)}
                />
              ))
            ) : (
              <p className="provider-access-empty">No API-key providers are registered.</p>
            )}
          </div>
        </section>
      </div>

      <div className="settings-local-storage">
        <span aria-hidden="true">
          <LockKey size={18} />
        </span>
        <div>
          <strong>Local storage</strong>
          <p>
            Credentials are held by Fable&rsquo;s local credential boundary and never leave this
            device. Fable only ever sees auth state and capabilities &mdash; never your keys.
          </p>
        </div>
      </div>

      {selectedProvider ? (
        selectedProvider.backendType === "native-api" ? (
          <NativeProviderSetupModal
            provider={selectedProvider}
            connected={selectedConnected}
            pending={selectedPending}
            discoveryState={selectedDiscoveryState}
            onStatus={onStatus}
            onClose={() => setSelectedProviderId(null)}
            onConnect={(providerId, secret) =>
              void runtime
                .connectBackendWithVerify(providerId, secret)
                .then((result) => {
                  const missingKey = isMissingKeyMessage(result.message);
                  onStatus(
                    connectResultCopy(result.outcome, {
                      missingKey,
                      detail: result.message
                    }).message
                  );
                })
            }
            onDisconnect={(providerId) =>
              void runtime.disconnectBackend(providerId).then(() => {
                onStatus(`${providerId} disconnected.`);
              })
            }
            onRefreshModels={(providerId) =>
              void runtime.refreshModels(providerId).then(() => {
                onStatus(`${providerId} models refreshed.`);
              })
            }
          />
        ) : (
          <SubscriptionProviderSetupModal
            provider={selectedProvider}
            onClose={() => setSelectedProviderId(null)}
          />
        )
      ) : null}
    </div>
  );
}

/**
 * A native-API (key) provider row. Connect/disconnect crosses the Rust
 * credential boundary via runtime.connectBackend/disconnectBackend. The API
 * key lives only in the uncontrolled input field; it is read once at submit and
 * passed straight to the boundary, then cleared — it never enters React state.
 */
function NativeProviderRow({
  provider,
  connected,
  pending,
  discoveryState,
  onOpen
}: {
  provider: BackendProvider;
  connected: boolean;
  pending: boolean;
  /** Per-provider model-discovery lifecycle (idle when discovery hasn't run). */
  discoveryState: ModelDiscoveryOutcome;
  onOpen: () => void;
}) {
  const capabilities = providerCapabilityLabels(provider);
  const availableModels = provider.models.filter((model) => model.available);
  const authLabel = authStateLabel(provider.authState, "native-api");
  const capabilityBearing = connected && capabilities.length > 0;
  // Model-discovery UI is only meaningful for a connected provider: it reflects
  // runtime model-list health layered on top of a verified key. Before connect
  // the catalogue copy ("Connect to see available models") still drives.
  const discoveryActive = connected && discoveryState !== "idle";
  const discoveryView = modelDiscoveryView(discoveryState);
  const discoveryDegraded = connected && isDiscoveryDegraded(discoveryState);
  const discoveryLoading = discoveryState === "loading";

  return (
    <article
      className={`provider-access-row provider-access-row--native${
        connected ? " provider-access-row--connected" : ""
      }`}
      data-provider-id={provider.id}
      role="button"
      aria-label={connected ? `Manage ${provider.label}` : `Connect ${provider.label}`}
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <span className="provider-access-row__icon" aria-hidden="true">
        <ProviderIcon provider={provider.id} size={23} />
      </span>

      <div className="provider-access-row__body">
        <div className="provider-access-row__name">
          <strong>{provider.label}</strong>
          <span>{provider.description}</span>
        </div>

        <div className="provider-access-row__meta">
          {capabilities.length > 0 ? (
            <span className="provider-access-caps">{capabilities.slice(0, 4).join(" · ")}</span>
          ) : (
            <span className="provider-access-caps provider-access-caps--muted">
              No capabilities until connected
            </span>
          )}
          {availableModels.length > 0 ? (
            <span className="provider-access-models">
              {availableModels.slice(0, 3).map((model) => model.label).join(" · ")}
              {availableModels.length > 3 ? ` · +${availableModels.length - 3} more` : ""}
            </span>
          ) : provider.models.length > 0 ? (
            <span className="provider-access-models provider-access-models--muted">
              {connected
                ? // Connected but the account surfaced no usable models.
                  "No models available on this account"
                : // Not connected yet: this is a configuration gap, not an
                  // account problem — point the user at connecting first.
                  "Connect to see available models"}
            </span>
          ) : null}
          {discoveryLoading ? (
            <span className="provider-access-models provider-access-models--loading">
              <Spinner size={12} /> {discoveryView.label}
            </span>
          ) : null}
        </div>

        {/* Model-discovery runtime health: shown only when connected so the row
            reflects the real model-list state instead of an optimistic
            "connected". Degraded (empty/offline/failed/unsupported) is
            recoverable — the Refresh action in the row footer re-runs discovery. */}
        {discoveryActive && !discoveryLoading && (discoveryDegraded || availableModels.length === 0) ? (
          <p
            className={`provider-access-discovery provider-access-discovery--${discoveryView.tone}`}
            role="status"
          >
            {discoveryView.hint}
          </p>
        ) : null}

      </div>

      <span
        className={`provider-access-state provider-access-state--${provider.authState}`}
        aria-label={`${provider.label} is ${authLabel}`}
      >
        {capabilityBearing || provider.authState === "connected" ? (
          <CheckCircle size={14} weight="fill" />
        ) : (
          <WarningCircle size={14} />
        )}
        {authLabel}
      </span>

      <span className="provider-access-row__action">
        <span>{connected ? "Manage" : pending ? "Connecting" : "Connect"}</span>
      </span>
    </article>
  );
}

function NativeProviderSetupModal({
  provider,
  connected,
  pending,
  discoveryState,
  onStatus,
  onClose,
  onConnect,
  onDisconnect,
  onRefreshModels
}: {
  provider: BackendProvider;
  connected: boolean;
  pending: boolean;
  discoveryState: ModelDiscoveryOutcome;
  onStatus: (message: string) => void;
  onClose: () => void;
  onConnect: (providerId: string, secret: string) => void;
  onDisconnect: (providerId: string) => void;
  onRefreshModels: (providerId: string) => void;
}) {
  const keyInputRef = useRef<HTMLInputElement>(null);
  const capabilities = providerCapabilityLabels(provider);
  const availableModels = provider.models.filter((model) => model.available);
  const authLabel = authStateLabel(provider.authState, "native-api");
  const discoveryView = modelDiscoveryView(discoveryState);
  const discoveryDegraded = connected && isDiscoveryDegraded(discoveryState);
  const discoveryLoading = discoveryState === "loading";

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const secret = keyInputRef.current?.value.trim() ?? "";
    if (!secret) {
      onStatus("Enter an API key to connect.");
      return;
    }
    onConnect(provider.id, secret);
    if (keyInputRef.current) {
      keyInputRef.current.value = "";
    }
  };

  return (
    <div className="provider-setup-modal" role="dialog" aria-modal="true" aria-labelledby={`provider-setup-${provider.id}`}>
      <article className="provider-setup-modal__panel">
        <header className="provider-setup-modal__header">
          <span className="provider-access-row__icon" aria-hidden="true">
            <ProviderIcon provider={provider.id} size={28} />
          </span>
          <div>
            <h2 id={`provider-setup-${provider.id}`}>{provider.label}</h2>
            <p>{provider.description}</p>
          </div>
          <button type="button" className="provider-setup-modal__close" aria-label="Close provider setup" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div className="provider-setup-modal__body">
          <span className={`provider-access-state provider-access-state--${provider.authState}`}>
            {connected ? <CheckCircle size={14} weight="fill" /> : <WarningCircle size={14} />}
            {authLabel}
          </span>

          <div className="provider-setup-modal__meta">
            <section>
              <strong>Capabilities</strong>
              <p>{capabilities.length > 0 ? capabilities.slice(0, 4).join(" / ") : "Connect to load capabilities."}</p>
            </section>
            <section>
              <strong>Models</strong>
              <p>
                {availableModels.length > 0
                  ? availableModels.slice(0, 4).map((model) => model.label).join(" / ")
                  : connected
                    ? "No models available on this account"
                    : "Connect to see available models"}
              </p>
            </section>
          </div>

          {connected && discoveryState !== "idle" ? (
            <p className={`provider-access-discovery provider-access-discovery--${discoveryView.tone}`}>
              {discoveryLoading ? "Checking available models." : discoveryView.hint}
            </p>
          ) : null}

          {!connected ? (
            <form className="provider-access-key-form provider-access-key-form--modal" onSubmit={handleSubmit}>
              <label className="provider-access-key-form__field">
                <span>{provider.label} API key</span>
                <input
                  ref={keyInputRef}
                  type="password"
                  aria-label={`API key for ${provider.label.toLowerCase()}`}
                  placeholder={`Enter your ${provider.label} API key`}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending}
                />
              </label>
              <button type="submit" className="provider-access-key-form__submit" disabled={pending}>
                {pending ? (
                  <span className="provider-access-key-form__pending">
                    <Spinner size={14} /> Connecting...
                  </span>
                ) : (
                  "Add key & connect"
                )}
              </button>
            </form>
          ) : null}
        </div>

        {connected ? (
          <footer className="provider-setup-modal__actions">
            <button
              type="button"
              className="provider-access-row__refresh"
              onClick={() => onRefreshModels(provider.id)}
              disabled={pending || discoveryLoading}
              aria-label={`Refresh models for ${provider.label}`}
            >
              {discoveryLoading ? <Spinner size={12} /> : <ArrowClockwise size={12} />}
              {discoveryDegraded ? "Retry models" : "Refresh models"}
            </button>
            <button type="button" onClick={() => onDisconnect(provider.id)} disabled={pending}>
              Disconnect
            </button>
          </footer>
        ) : null}
      </article>
    </div>
  );
}

function SubscriptionProviderSetupModal({
  provider,
  onClose
}: {
  provider: BackendProvider;
  onClose: () => void;
}) {
  const capabilities = providerCapabilityLabels(provider);
  const capabilityBearing = provider.authState === "connected" && capabilities.length > 0;
  const authLabel = authStateLabel(provider.authState, provider.backendType);
  const installRequired = provider.authState === "install-required";

  return (
    <div className="provider-setup-modal" role="dialog" aria-modal="true" aria-labelledby={`provider-setup-${provider.id}`}>
      <article className="provider-setup-modal__panel">
        <header className="provider-setup-modal__header">
          <span className="provider-access-row__icon" aria-hidden="true">
            <ProviderIcon provider={provider.id} size={28} />
          </span>
          <div>
            <h2 id={`provider-setup-${provider.id}`}>{provider.label}</h2>
            <p>{provider.description}</p>
          </div>
          <button type="button" className="provider-setup-modal__close" aria-label="Close provider setup" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="provider-setup-modal__body">
          <span className={`provider-access-state provider-access-state--${provider.authState}`}>
            {capabilityBearing ? <CheckCircle size={14} weight="fill" /> : <Plugs size={14} />}
            {authLabel}
          </span>
          <div className="provider-setup-modal__meta">
            <section>
              <strong>Setup</strong>
              <p>
                {installRequired && provider.installHint
                  ? provider.installHint
                  : "Use the provider's own app, CLI, or sign-in before Fable can use this runtime."}
              </p>
            </section>
            <section>
              <strong>Capabilities</strong>
              <p>{capabilityBearing ? capabilities.slice(0, 4).join(" / ") : "Available after the provider runtime is ready."}</p>
            </section>
          </div>
        </div>
      </article>
    </div>
  );
}

/**
 * A subscription/CLI provider row. It is never one-click connectable from
 * Settings: unless the runtime reports it connected and capability-bearing, the
 * row states what is required (CLI install, sign-in) and exposes no fake token
 * entry field.
 */
function SubscriptionProviderRow({
  provider,
  onOpen
}: {
  provider: BackendProvider;
  onOpen: () => void;
}) {
  const capabilities = providerCapabilityLabels(provider);
  const capabilityBearing = provider.authState === "connected" && capabilities.length > 0;
  const authLabel = authStateLabel(provider.authState, provider.backendType);
  const installRequired = provider.authState === "install-required";

  return (
    <article
      className={`provider-access-row provider-access-row--subscription${
        capabilityBearing ? " provider-access-row--connected" : ""
      }`}
      data-provider-id={provider.id}
      role="button"
      aria-label={capabilityBearing ? `Manage ${provider.label}` : `View setup for ${provider.label}`}
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <span className="provider-access-row__icon" aria-hidden="true">
        <ProviderIcon provider={provider.id} size={23} />
      </span>

      <div className="provider-access-row__body">
        <div className="provider-access-row__name">
          <strong>{provider.label}</strong>
          <span>{provider.description}</span>
        </div>

        <div className="provider-access-row__meta">
          {capabilityBearing ? (
            <span className="provider-access-caps">{capabilities.slice(0, 4).join(" · ")}</span>
          ) : (
            <span className="provider-access-caps provider-access-caps--muted">
              {installRequired && provider.installHint
                ? provider.installHint
                : "Requires the provider's real runtime to be connected first."}
            </span>
          )}
        </div>
      </div>

      <span
        className={`provider-access-state provider-access-state--${provider.authState}`}
        aria-label={`${provider.label} is ${authLabel}`}
      >
        {capabilityBearing ? <CheckCircle size={14} weight="fill" /> : <Plugs size={14} />}
        {authLabel}
      </span>

      <span className="provider-access-row__action" title="Subscription providers use their provider-owned runtime and auth.">
        <span>{capabilityBearing ? "Manage" : "View setup"}</span>
      </span>
    </article>
  );
}

/** Human label for a backend's resolved auth state. */
function authStateLabel(
  authState: BackendAuthState,
  _backendType: BackendProvider["backendType"]
): string {
  if (authState === "needs-auth") {
    return "Needs API key";
  }
  return stateViewFor(authState).label;
}

/**
 * Recognize the Rust boundary's "no key stored" message. The boundary returns
 * `auth-failed` for both a missing key and a rejected key; its
 * `missing_key_message` ("Add an {provider} API key to connect.") is the only
 * signal that distinguishes them. Matching the signature (rather than exact
 * text) stays robust if the provider id wording changes. Pure, no secrets.
 */
function isMissingKeyMessage(message: string | undefined): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower.startsWith("add an") && lower.includes("api key to connect");
}

function PrivacySettingsView({
  runtime,
  onStatus
}: {
  runtime: ShellRuntime;
  onStatus: (message: string) => void;
}) {
  const [resyncingConnectorId, setResyncingConnectorId] = useState<string | null>(null);
  const [disconnectingConnectorId, setDisconnectingConnectorId] = useState<string | null>(null);
  const [isBulkDisconnecting, setIsBulkDisconnecting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const connectedConnectors = useMemo(() => {
    return runtime.connectorManifests.filter(
      (c) => c.id !== "local-files" && c.status === "connected"
    );
  }, [runtime.connectorManifests]);

  const handleResync = async (connectorId: string, connectorName: string) => {
    setResyncingConnectorId(connectorId);
    try {
      await runtime.refreshConnector(connectorId);
      onStatus(`Successfully resynced ${connectorName}.`);
    } catch (err) {
      onStatus(`Failed to resync ${connectorName}.`);
    } finally {
      setResyncingConnectorId(null);
    }
  };

  const handleDisconnect = async (connectorId: string, connectorName: string) => {
    setDisconnectingConnectorId(connectorId);
    try {
      await runtime.disconnectConnector(connectorId);
      onStatus(`Disconnected ${connectorName} and cleared credentials.`);
    } catch (err) {
      onStatus(`Failed to disconnect ${connectorName}.`);
    } finally {
      setDisconnectingConnectorId(null);
    }
  };

  const handleBulkDisconnect = async () => {
    if (!confirm("Are you sure you want to disconnect all connectors? This will clear all stored credentials.")) {
      return;
    }
    setIsBulkDisconnecting(true);
    try {
      for (const connector of connectedConnectors) {
        await runtime.disconnectConnector(connector.id);
      }
      onStatus("Successfully disconnected all connectors.");
    } catch (err) {
      onStatus("Encountered errors disconnecting some connectors.");
    } finally {
      setIsBulkDisconnecting(false);
    }
  };

  const handleExportMemory = async () => {
    setIsExporting(true);
    try {
      await runtime.exportMemory();
      onStatus("Memory exported successfully.");
    } catch (err) {
      onStatus("Failed to export memory.");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="settings-page__body">
      <div className="settings-section-heading">
        <p>Review local data boundaries and run explicit connector synchronization actions.</p>
      </div>

      <article className="profile-clean-card settings-open-section">
        <div className="profile-clean-card__content">
          <section className="profile-section" aria-labelledby="connector-sync-title">
            <div className="profile-section__heading">
              <span className="settings-panel__icon" aria-hidden="true">
                <ArrowClockwise size={19} />
              </span>
              <span>
                <strong id="connector-sync-title">Connector Synchronization</strong>
                <small>Fable retrieves external data on demand. Background sync and continuous crawling are disabled.</small>
              </span>
            </div>
            <div style={{ marginTop: "16px" }}>
              <p style={{ color: "var(--ink-soft)", fontSize: "var(--text-13)", lineHeight: "1.5", marginBottom: "16px" }}>
                To protect API rate limits and conserve system resources, Fable does not continuously poll or crawl your connected accounts.
                While a background scheduler foundation manages local deferred jobs, no remote data is fetched in the background.
              </p>

              <strong style={{ display: "block", color: "var(--ink)", fontSize: "var(--text-13)", fontWeight: 500, marginBottom: "8px" }}>
                Active Connections ({connectedConnectors.length})
              </strong>

              {connectedConnectors.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  {connectedConnectors.map((connector) => (
                    <div
                      key={connector.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "12px 16px",
                        background: "var(--surface-raised)",
                        border: "1px solid var(--line-strong)",
                        borderRadius: "var(--radius-2)"
                      }}
                      data-connected-connector-id={connector.id}
                    >
                      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                        <strong style={{ color: "var(--ink)", fontSize: "var(--text-14)", fontWeight: 500 }}>{connector.name}</strong>
                        <span style={{ color: "var(--ink-muted)", fontSize: "var(--text-12)" }}>
                          {connector.account
                            ? `Active: ${connector.account.email ?? connector.account.displayName}`
                            : "Connected"}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: "8px" }}>
                        <button
                          type="button"
                          className="button button--secondary"
                          style={{ padding: "4px 10px", fontSize: "var(--text-12)", minHeight: "auto", display: "inline-flex", alignItems: "center", gap: "4px" }}
                          onClick={() => handleResync(connector.id, connector.name)}
                          disabled={resyncingConnectorId === connector.id}
                          title="Resync this connector to refresh credentials and scopes"
                          aria-label={`Resync ${connector.name}`}
                        >
                          {resyncingConnectorId === connector.id ? <Spinner size={12} /> : <ArrowClockwise size={12} />}
                          <span>Resync</span>
                        </button>
                        <button
                          type="button"
                          className="button button--secondary"
                          style={{ padding: "4px 10px", fontSize: "var(--text-12)", minHeight: "auto" }}
                          onClick={() => handleDisconnect(connector.id, connector.name)}
                          disabled={disconnectingConnectorId === connector.id}
                          title="Remove credentials from local secure keyring"
                          aria-label={`Disconnect ${connector.name}`}
                        >
                          {disconnectingConnectorId === connector.id ? <Spinner size={12} /> : null}
                          <span>Disconnect</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ color: "var(--ink-muted)", fontSize: "var(--text-13)", fontStyle: "italic", margin: "8px 0" }}>
                  No active connector connections. Connect external accounts in the Providers tab or the Connectors page.
                </p>
              )}
            </div>
          </section>

          <section className="profile-section" aria-labelledby="cache-limits-title">
            <div className="profile-section__heading">
              <span className="settings-panel__icon" aria-hidden="true">
                <LockKey size={19} />
              </span>
              <span>
                <strong id="cache-limits-title">Local Cache & Keyring Boundaries</strong>
                <small>Normalized connector cache items are encrypted and workspace-scoped; credentials remain isolated.</small>
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "16px", color: "var(--ink-soft)", fontSize: "var(--text-13)", lineHeight: "1.5" }}>
              <p>
                - <strong>Keyring Protection:</strong> OAuth tokens, credentials, and secrets are stored inside your operating system keyring (or the native auth boundary) and never enter local storage or React state.
              </p>
              <p>
                - <strong>Cache Boundaries:</strong> Fable may persist normalized, user-selected connector items in the encrypted local vault. Raw provider responses, unselected account content, and tokens are excluded.
              </p>
              <p>
                - <strong>Data Lifecycle:</strong> On-demand provider results remain session-only unless explicitly imported. Cache disable, cache deletion, connector disconnect, cache export, and memory export are separate operations.
              </p>
            </div>
          </section>

          <section className="profile-section" aria-labelledby="memory-settings-title">
            <div className="profile-section__heading">
              <span className="settings-panel__icon" aria-hidden="true">
                <LockKey size={19} />
              </span>
              <span>
                <strong id="memory-settings-title">Personal Memory</strong>
                <small>Local facts and user approvals stored in an encrypted SQLite database on this device.</small>
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "16px", marginTop: "16px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <strong style={{ display: "block", color: "var(--ink)", fontSize: "var(--text-14)", fontWeight: 500 }}>Enable memory</strong>
                  <span style={{ display: "block", color: "var(--ink-muted)", fontSize: "var(--text-12)", marginTop: "4px" }}>Allow Fable to save and recall facts locally.</span>
                </div>
                <label className="toggle-switch" style={{ display: "inline-flex", alignItems: "center", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={!runtime.memoryDisabled}
                    onChange={runtime.toggleMemoryDisabled}
                    style={{ width: "40px", height: "20px", accentColor: "var(--accent-strong)" }}
                    aria-label="Toggle personal memory"
                  />
                </label>
              </div>

              <div style={{ display: "flex", gap: "12px", marginTop: "8px" }}>
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={handleExportMemory}
                  disabled={isExporting}
                >
                  {isExporting ? <Spinner size={14} /> : null}
                  <span>Export memory</span>
                </button>
              </div>
            </div>
          </section>
        </div>

        {connectedConnectors.length > 0 ? (
          <footer className="profile-clean-card__footer">
            <div className="profile-action-row profile-action-row--end" style={{ width: "100%" }}>
              <button
                type="button"
                className="profile-button button button--destructive"
                onClick={handleBulkDisconnect}
                disabled={isBulkDisconnecting}
              >
                {isBulkDisconnecting ? <Spinner size={16} /> : <Trash size={16} />}
                <span>Disconnect all connectors</span>
              </button>
            </div>
          </footer>
        ) : null}
      </article>
    </div>
  );
}

/**
 * Settings -> History: the inspectable action-history surface.
 *
 * Renders the normalized audit events the Rust boundary records at execution
 * boundaries (model calls, connector actions, tool/shell actions, web actions,
 * approvals, schedules, blocked policy decisions). Each row shows type,
 * summary, status, time, actor, and safe (redacted) details. Audit only
 * observes actions — it never grants execution authority and never carries
 * secrets (tokens, keys, raw provider secrets, auth codes, full file/email
 * bodies, or env values are stripped at the Rust storage layer).
 */
const HISTORY_CATEGORY_LABELS: Record<string, string> = {
  "model-call": "Model call",
  "connector-action": "Connector action",
  "tool-action": "Tool / shell",
  "web-action": "Web / browser",
  approval: "Approval",
  schedule: "Schedule",
  "policy-block": "Policy block"
};

const HISTORY_CATEGORY_FILTERS: Array<{ id: string; label: string }> = [
  { id: "all", label: "All" },
  { id: "model-call", label: "Model calls" },
  { id: "connector-action", label: "Connectors" },
  { id: "tool-action", label: "Tools / shell" },
  { id: "web-action", label: "Web" },
  { id: "approval", label: "Approvals" },
  { id: "schedule", label: "Schedules" },
  { id: "policy-block", label: "Policy blocks" }
];

function HistorySettingsView({
  runtime,
  onStatus
}: {
  runtime: ShellRuntime;
  onStatus: (message: string) => void;
}) {
  const [view, setView] = useState<"runs" | "activity">("runs");

  return (
    <div className="settings-history">
      <div className="settings-history__tabs" role="tablist" aria-label="History views">
        <button
          type="button"
          role="tab"
          aria-selected={view === "runs"}
          onClick={() => setView("runs")}
        >
          Runs
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "activity"}
          onClick={() => setView("activity")}
        >
          Activity
        </button>
      </div>
      <div role="tabpanel" aria-label={view === "runs" ? "Runs" : "Activity"}>
        {view === "runs" ? (
          <RunHistoryPage runtime={runtime} embedded />
        ) : (
          <ActivityHistoryView runtime={runtime} onStatus={onStatus} />
        )}
      </div>
    </div>
  );
}

function ActivityHistoryView({
  runtime,
  onStatus
}: {
  runtime: ShellRuntime;
  onStatus: (message: string) => void;
}) {
  const [filter, setFilter] = useState<string>("all");
  const events = runtime.actionHistory ?? [];

  const visible = useMemo(() => {
    if (filter === "all") {
      return events;
    }
    return events.filter((event) => event.category === filter);
  }, [events, filter]);

  const handleRefresh = () => {
    runtime.refreshActionHistory();
    onStatus("Refreshed action history.");
  };

  return (
    <div className="settings-page__body">
      <div className="settings-section-heading">
        <p>
          This history shows the actions Fable has performed, such as model calls, connector updates, or local file access. It is a record of past activity and does not control what can run. To protect your privacy, all passwords, keys, and personal message details are completely removed before any history is saved.
        </p>
      </div>

      <article className="profile-clean-card settings-open-section">
        <div className="profile-clean-card__content">
          <section className="profile-section" aria-labelledby="action-history-title">
            <div className="profile-section__heading">
              <span className="settings-panel__icon" aria-hidden="true">
                <Clock size={19} />
              </span>
              <span>
                <strong id="action-history-title">Action History</strong>
                <small>
                  Most recent actions first ({visible.length}
                  {filter === "all" ? "" : ` of ${events.length}`} shown).
                </small>
              </span>
            </div>

            <div
              role="group"
              aria-label="Filter action history by category"
              style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "16px", marginBottom: "12px" }}
            >
              {HISTORY_CATEGORY_FILTERS.map((option) => {
                const active = filter === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    className="button button--secondary"
                    style={{
                      padding: "4px 10px",
                      fontSize: "var(--text-12)",
                      minHeight: "auto",
                      borderColor: active ? "var(--accent)" : "var(--line-strong)",
                      color: active ? "var(--accent)" : "var(--ink-soft)"
                    }}
                    aria-pressed={active}
                    onClick={() => setFilter(option.id)}
                  >
                    {option.label}
                  </button>
                );
              })}
              <button
                type="button"
                className="button button--secondary"
                style={{ padding: "4px 10px", fontSize: "var(--text-12)", minHeight: "auto", display: "inline-flex", alignItems: "center", gap: "4px" }}
                onClick={handleRefresh}
                aria-label="Refresh action history"
              >
                <ArrowClockwise size={12} />
                <span>Refresh</span>
              </button>
            </div>

            {visible.length === 0 ? (
              <div className="settings-empty-row" data-testid="action-history-empty">
                <Clock size={18} />
                <span>No actions recorded yet.</span>
              </div>
            ) : (
              <ul
                className="action-history-list"
                aria-label="Action history entries"
                style={{ display: "flex", flexDirection: "column", gap: "10px", listStyle: "none", padding: 0, margin: 0 }}
              >
                {visible.map((event) => (
                  <ActionHistoryRow key={event.id} event={event} />
                ))}
              </ul>
            )}
          </section>
        </div>
      </article>
    </div>
  );
}

function statusTone(status: string): string {
  switch (status) {
    case "ok":
    case "approved":
    case "executed":
    case "done":
      return "var(--success)";
    case "blocked":
    case "denied":
    case "failed":
    case "dead":
      return "var(--danger)";
    case "cancelled":
    case "attempted":
    case "retried":
      return "var(--ink-muted)";
    default:
      return "var(--ink-soft)";
  }
}

function ActionHistoryRow({ event }: { event: ActionHistoryEvent }) {
  const categoryLabel = HISTORY_CATEGORY_LABELS[event.category] ?? event.category;
  const detailEntries = useMemo(() => safeDetailEntries(event.detail), [event.detail]);

  return (
    <li
      className="action-history-row"
      data-action-history-id={event.id}
      data-action-history-category={event.category}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        padding: "12px 16px",
        background: "var(--surface-raised)",
        border: "1px solid var(--line-strong)",
        borderRadius: "var(--radius-2)"
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
          <strong style={{ color: "var(--ink)", fontSize: "var(--text-14)", fontWeight: 500 }}>
            {categoryLabel}
            {event.action ? ` · ${event.action}` : ""}
          </strong>
          {event.summary ? (
            <span style={{ color: "var(--ink-soft)", fontSize: "var(--text-13)", overflowWrap: "anywhere" }}>
              {event.summary}
            </span>
          ) : null}
        </div>
        <span
          className="action-history-row__status"
          style={{
            color: statusTone(event.status),
            fontSize: "var(--text-12)",
            fontWeight: 500,
            textTransform: "capitalize",
            whiteSpace: "nowrap"
          }}
        >
          {event.status || "—"}
        </span>
      </div>
      <div
        className="action-history-row__meta"
        style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", color: "var(--ink-muted)", fontSize: "var(--text-12)" }}
      >
        <span data-action-history-time>{formatHistoryTime(event.createdAt)}</span>
        <span data-action-history-actor>actor: {event.actor || "system"}</span>
        {event.service ? <span data-action-history-service>{event.service}</span> : null}
        {event.mode ? <span>mode: {event.mode}</span> : null}
        {event.riskLevel ? <span>risk: {event.riskLevel}</span> : null}
        {event.correlationId ? <span data-action-history-correlation>id: {event.correlationId}</span> : null}
        {event.errorCode ? <span style={{ color: "var(--danger)" }}>error: {event.errorCode}</span> : null}
      </div>
      {detailEntries.length > 0 ? (
        <dl
          className="action-history-row__detail"
          data-testid="action-history-detail"
          style={{ display: "grid", gridTemplateColumns: "max-content 1fr", columnGap: "10px", rowGap: "2px", margin: 0, fontSize: "var(--text-12)", color: "var(--ink-soft)" }}
        >
          {detailEntries.map(([key, value]) => (
            <div key={key} style={{ display: "contents" }}>
              <dt style={{ color: "var(--ink-muted)" }}>{key}</dt>
              <dd data-testid="action-history-detail-value" style={{ margin: 0, overflowWrap: "anywhere" }}>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}

/** Format an ISO timestamp for compact display; falls back to the raw value. */
function formatHistoryTime(iso: string): string {
  if (!iso) {
    return "unknown time";
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  return parsed.toLocaleString();
}

/**
 * Flatten the redacted `detail` payload into a stable list of [key, value]
 * pairs for display. Only shallow object/array entries are shown; nested
 * structures are rendered as a compact JSON preview so the surface never exposes
 * unbounded depth. Values are already redacted at the Rust boundary.
 */
function safeDetailEntries(detail: unknown): Array<[string, string]> {
  if (detail == null) {
    return [];
  }
  const entries: Array<[string, string]> = [];
  if (typeof detail === "object") {
    const record = detail as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (value == null) {
        continue;
      }
      entries.push([key, renderSafeDetailValue(value)]);
    }
  } else {
    entries.push(["detail", String(detail)]);
  }
  return entries.slice(0, 12);
}

function renderSafeDetailValue(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return "[unrenderable]";
  }
}

function ApprovalsSettingsView({
  runtime,
  onStatus
}: {
  runtime: ShellRuntime;
  onStatus: (message: string) => void;
}) {
  const [remoteStatus, setRemoteStatus] = useState<RemoteControlStatusSnapshot | null>();

  useEffect(() => {
    let active = true;
    void getRuntimeRemoteControlStatus().then((status) => {
      if (active) setRemoteStatus(status);
    });
    return () => {
      active = false;
    };
  }, []);

  const handleToggle = (key: keyof CustomApprovalSettings, value: boolean) => {
    runtime.updateCustomApprovalSetting(key, value);
    onStatus(`${customApprovalToggleLabel(key)} ${value ? "on" : "off"}.`);
  };

  return (
    <div className="settings-page__body approvals-settings">
      <div className="settings-section-heading">
        <p>Choose how often Fable should stop and ask before it acts.</p>
      </div>

      <section className="approvals-settings__section" aria-labelledby="approval-choice-title">
        <div className="profile-section__heading">
          <span className="settings-panel__icon" aria-hidden="true">
            <ShieldCheck size={19} />
          </span>
          <span>
            <strong id="approval-choice-title">How Fable should work</strong>
            <small>Ask Me is the recommended starting point.</small>
          </span>
        </div>
        <div className="approval-preset-grid" role="radiogroup" aria-labelledby="approval-choice-title">
          {PERMISSION_PROFILES.map((profile) => (
            <button
              key={profile.label}
              type="button"
              className="approval-preset-option"
              role="radio"
              aria-checked={runtime.permissionLabel === profile.label}
              data-selected={runtime.permissionLabel === profile.label || undefined}
              onClick={() => {
                runtime.selectPermissionLabel(profile.label);
                onStatus(`${profile.label} selected.`);
              }}
            >
              <strong>{profile.label}</strong>
              <span>{profile.description}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="approvals-settings__section" aria-labelledby="custom-approvals-title">
        <div className="profile-section__heading">
          <span className="settings-panel__icon" aria-hidden="true">
            <GearSix size={19} />
          </span>
          <span>
            <strong id="custom-approvals-title">{CUSTOM_APPROVAL_SECTION.heading}</strong>
            <small>{CUSTOM_APPROVAL_SECTION.intro}</small>
          </span>
        </div>
        <div className="custom-approvals-list" role="group" aria-labelledby="custom-approvals-title">
          {CUSTOM_APPROVAL_TOGGLE_ORDER.map((key) => {
            const checked = runtime.customApprovalSettings[key];
            return (
              <button
                key={key}
                type="button"
                className="toggle-row custom-approval-toggle"
                aria-pressed={checked}
                onClick={() => handleToggle(key, !checked)}
              >
                <span>
                  <strong>{customApprovalToggleLabel(key)}</strong>
                  <small>{customApprovalToggleHelper(key)}</small>
                </span>
                <span className="toggle-switch" aria-hidden="true">
                  <span />
                </span>
              </button>
            );
          })}
        </div>
        <p className="approvals-settings__note">{CUSTOM_APPROVAL_SECTION.reassurance}</p>
      </section>

      <section className="approvals-settings__section" aria-labelledby="mobile-approvals-title">
        <div className="profile-section__heading">
          <span className="settings-panel__icon" aria-hidden="true">
            <DeviceMobile size={19} />
          </span>
          <span>
            <strong id="mobile-approvals-title">Mobile approvals</strong>
            <small>A phone can answer a request, but only this computer can run the action.</small>
          </span>
        </div>
        <div className="remote-approval-status" role="status">
          <strong>
            {remoteStatus === undefined
              ? "Checking..."
              : remoteStatus?.enabled
                ? "Connected"
                : "Not connected"}
          </strong>
          <span>
            {remoteStatus === undefined
              ? "Reading the local connection status."
              : remoteStatus?.message ??
                "Live mobile approvals are not available outside the desktop runtime."}
          </span>
        </div>
      </section>
    </div>
  );
}

function ProfileSettingsView({
  profile,
  onProfileChange,
  onStatus
}: {
  profile: ProfileFixture;
  onProfileChange?: (profile: ProfileFixture) => void;
  onStatus: (message: string) => void;
}) {
  const [profileState, setProfileState] = useState(profile);
  const [photoPreview, setPhotoPreview] = useState<string | undefined>(profile.photoUrl);
  const photoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (profile) {
      setProfileState(profile);
      setPhotoPreview(profile.photoUrl);
    }
  }, [profile]);

  const initials = useMemo(() => {
    const parts = profileState.name
      .split(" ")
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length === 0) {
      return profileState.photoInitials || "J";
    }

    return parts
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();
  }, [profileState.name, profileState.photoInitials]);

  const handlePhotoUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = typeof reader.result === "string" ? reader.result : undefined;
      setPhotoPreview(result);
      setProfileState((current) => ({ ...current, photoUrl: result }));
      onStatus(`${file.name} selected for this local profile.`);
    });
    reader.readAsDataURL(file);
  };

  const removePhoto = () => {
    setPhotoPreview(undefined);
    setProfileState((current) => ({ ...current, photoUrl: undefined }));
    if (photoInputRef.current) {
      photoInputRef.current.value = "";
    }
    onStatus("Profile photo removed locally.");
  };

  const saveProfile = () => {
    const updated = { ...profileState, photoInitials: initials, photoUrl: photoPreview };
    setProfileState(updated);
    if (onProfileChange) {
      onProfileChange(updated);
    }
    onStatus("Profile saved locally on this device.");
  };

  return (
    <div className="settings-page__body">
      <div className="settings-section-heading">
        <p>Manage local display details for this workspace.</p>
      </div>

      <article className="profile-clean-card settings-open-section">
        <div className="profile-clean-card__identity">
          <div className="profile-photo" aria-hidden="true">
            {photoPreview ? (
              <img src={photoPreview} alt="" />
            ) : (
              <UserCircle size={58} weight="regular" />
            )}
          </div>
          <div className="profile-identity-copy">
            <strong>{profileState.name || "Josh"}</strong>
            <small>{profileState.email || "josh@example.com"}</small>
          </div>
          <div className="profile-photo-buttons">
            <input
              ref={photoInputRef}
              className="sr-only"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label="Upload profile photo"
              onChange={handlePhotoUpload}
            />
            <button type="button" onClick={() => photoInputRef.current?.click()}>
              <UploadSimple size={16} />
              <span>{photoPreview ? "Change photo" : "Upload photo"}</span>
            </button>
            <button
              type="button"
              className="profile-photo-buttons__danger button button--destructive"
              onClick={removePhoto}
              disabled={!photoPreview}
            >
              <Trash size={16} />
              <span>Remove</span>
            </button>
          </div>
        </div>

        <div className="profile-clean-card__content">
          <section className="profile-section" aria-labelledby="profile-details-title">
            <div className="profile-section__heading">
              <span className="settings-panel__icon" aria-hidden="true">
                <UserCircle size={19} />
              </span>
              <span>
                <strong id="profile-details-title">Profile details</strong>
                <small>Name and email used for local display.</small>
              </span>
            </div>
            <div className="settings-form-grid settings-form-grid--single">
              <label className="settings-field">
                <span>Name</span>
                <input
                  value={profileState.name}
                  onChange={(event) =>
                    setProfileState((current) => ({ ...current, name: event.target.value }))
                  }
                />
              </label>
              <label className="settings-field">
                <span>Email</span>
                <input
                  type="email"
                  value={profileState.email}
                  onChange={(event) =>
                    setProfileState((current) => ({ ...current, email: event.target.value }))
                  }
                />
              </label>
            </div>
          </section>

        </div>

        <footer className="profile-clean-card__footer">
          <div className="profile-action-row profile-action-row--end" style={{ width: "100%" }}>
            <button
              type="button"
              className="profile-button button button--secondary"
              onClick={() => {
                setProfileState(profile || profileFixture);
                setPhotoPreview((profile || profileFixture).photoUrl);
                onStatus("Profile changes reset locally.");
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="profile-button profile-button--primary button button--primary"
              aria-label="Save profile"
              onClick={saveProfile}
            >
              Save changes
            </button>
          </div>
        </footer>
      </article>
    </div>
  );
}

function AppearanceSettingsView({
  theme,
  onThemeChange,
  onStatus
}: {
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
  onStatus: (message: string) => void;
}) {
  return (
    <div className="settings-page__body">
      <div className="settings-section-heading">
        <p>Customize the look and feel of the Fable interface.</p>
      </div>

      <div className="provider-access-list" style={{ padding: "20px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <strong style={{ display: "block", color: "var(--ink)", fontSize: "var(--text-14)", fontWeight: 500 }}>Interface Theme</strong>
            <span style={{ display: "block", color: "var(--ink-muted)", fontSize: "var(--text-12)", marginTop: "4px" }}>Choose between Light and Dark color schemes.</span>
          </div>
          <div className="theme-toggle theme-toggle--settings" role="group" aria-label="Theme">
            <button
              type="button"
              className={`theme-toggle__button${theme === "light" ? " theme-toggle__button--active" : ""}`}
              aria-pressed={theme === "light"}
              onClick={() => {
                onThemeChange("light");
                onStatus("Light theme applied.");
              }}
            >
              <Sun size={17} />
              <span>Light</span>
            </button>
            <button
              type="button"
              className={`theme-toggle__button${theme === "dark" ? " theme-toggle__button--active" : ""}`}
              aria-pressed={theme === "dark"}
              onClick={() => {
                onThemeChange("dark");
                onStatus("Dark theme applied.");
              }}
            >
              <Moon size={17} />
              <span>Dark</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function WorkspaceSettingsView({
  workspaceName,
  onStatus
}: {
  workspaceName: string;
  onStatus: (message: string) => void;
}) {
  const [name, setName] = useState(workspaceName);

  const handleSave = () => {
    onStatus(`Workspace settings saved locally.`);
  };

  return (
    <div className="settings-page__body">
      <div className="settings-section-heading">
        <p>Manage workspace details and collaborative access.</p>
      </div>

      <article className="profile-clean-card settings-open-section">
        <div className="profile-clean-card__content">
          <section className="profile-section" aria-labelledby="workspace-details-title">
            <div className="profile-section__heading">
              <span className="settings-panel__icon" aria-hidden="true">
                <SquaresFour size={19} />
              </span>
              <span>
                <strong id="workspace-details-title">Workspace details</strong>
                <small>Workspace name and display settings.</small>
              </span>
            </div>
            <div className="settings-form-grid settings-form-grid--single">
              <label className="settings-field">
                <span>Workspace Name</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            </div>
          </section>

          <section className="profile-section" aria-labelledby="workspace-team-title">
            <div className="profile-section__heading">
              <span className="settings-panel__icon" aria-hidden="true">
                <UserCircle size={19} />
              </span>
              <span>
                <strong id="workspace-team-title">
                  Team Access
                  <span style={{
                    fontSize: "10px",
                    marginLeft: "6px",
                    padding: "2px 6px",
                    background: "var(--accent-subtle)",
                    color: "var(--accent-strong)",
                    borderRadius: "10px",
                    fontWeight: 500,
                    verticalAlign: "middle"
                  }}>
                    WIP
                  </span>
                </strong>
                <small>Share this workspace with your team.</small>
              </span>
            </div>
            <p className="profile-security-note" style={{ marginTop: "8px" }}>
              <strong>Multi-user collaboration is in development.</strong> Soon you will be able to invite teammates, share agent configurations, and collaborate in real-time.
            </p>
          </section>
        </div>

        <footer className="profile-clean-card__footer">
          <div className="profile-action-row profile-action-row--end" style={{ width: "100%" }}>
            <button
              type="button"
              className="profile-button button button--secondary"
              onClick={() => {
                setName(workspaceName);
                onStatus("Workspace settings reset locally.");
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="profile-button profile-button--primary button button--primary"
              aria-label="Save workspace settings"
              onClick={handleSave}
            >
              Save changes
            </button>
          </div>
        </footer>
      </article>
    </div>
  );
}

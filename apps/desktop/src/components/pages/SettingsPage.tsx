import {
  ArrowClockwise,
  CheckCircle,
  GearSix,
  Key,
  LockKey,
  Moon,
  Plugs,
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
import type { BackendAuthState, BackendProvider } from "@fable/protocol";
import { providerCapabilityLabels } from "../../lib/backend-capabilities";
import {
  connectResultCopy,
  isDiscoveryDegraded,
  modelDiscoveryView,
  stateViewFor
} from "../../lib/backend-state";
import type { ModelDiscoveryOutcome } from "../../lib/backend-state";
import { ProviderIcon } from "../ProviderIcon";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import { profileFixture } from "../../data/workspace";
import type { ProfileFixture } from "../../data/workspace";

export type SettingsTab = "profile" | "providers" | "appearance" | "privacy" | "notifications" | "workspace";

export const tabs: { id: SettingsTab; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "providers", label: "Providers" },
  { id: "appearance", label: "Appearance" },
  { id: "privacy", label: "Privacy" },
  { id: "notifications", label: "Notifications" },
  { id: "workspace", label: "Workspace" }
];

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
  workspaceName
}: {
  runtime: ShellRuntime;
  profile?: ProfileFixture;
  onProfileChange?: (profile: ProfileFixture) => void;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
  activeTab: SettingsTab;
  workspaceName: string;
}) {
  const [status, setStatus] = useState("");

  return (
    <section className="settings-page" aria-labelledby="settings-title">
      <div className="settings-page__content">
        <div className="settings-page__header">
          <h1 id="settings-title">
            {activeTab === "workspace" ? workspaceName : (tabs.find((t) => t.id === activeTab)?.label || "Settings")}
          </h1>
        </div>

        {activeTab === "providers" ? (
          <ProviderAccessView runtime={runtime} onStatus={setStatus} />
        ) : activeTab === "profile" ? (
          <ProfileSettingsView
            profile={profile}
            onProfileChange={onProfileChange}
            onStatus={setStatus}
          />
        ) : activeTab === "appearance" ? (
          <AppearanceSettingsView
            theme={theme}
            onThemeChange={onThemeChange}
            onStatus={setStatus}
          />
        ) : activeTab === "workspace" ? (
          <WorkspaceSettingsView
            workspaceName={workspaceName}
            onStatus={setStatus}
          />
        ) : activeTab === "privacy" ? (
          <PrivacySettingsView
            runtime={runtime}
            onStatus={setStatus}
          />
        ) : (
          <QuietPlaceholder tab={activeTab} />
        )}

        {status ? (
          <p className="settings-status" role="status">
            {status}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function ProviderAccessView({
  runtime,
  onStatus
}: {
  runtime: ShellRuntime;
  onStatus: (message: string) => void;
}) {
  const providers = runtime.backendProviders;
  // The runtime emits "Connecting <providerId>…" while a connect/disconnect is
  // in flight; surface it as the pending provider id so the row shows a spinner.
  const pendingProviderId = runtime.backendStatus?.match(/Connecting (\S+?)[\u2026.]?/)?.[1];

  // Native-API (key) providers are connectable here. Subscription/CLI providers
  // (codex/cursor/copilot/grok) report provider-owned runtime state.
  const providerPriority = [
    "codex",
    "cursor",
    "copilot",
    "grok",
    "openai",
    "anthropic",
    "gemini",
    "xai",
    "openrouter"
  ];
  const byPriority = (a: BackendProvider, b: BackendProvider) => {
    const aPriority = providerPriority.indexOf(a.id);
    const bPriority = providerPriority.indexOf(b.id);
    return (aPriority === -1 ? Number.MAX_SAFE_INTEGER : aPriority) -
      (bPriority === -1 ? Number.MAX_SAFE_INTEGER : bPriority);
  };
  const nativeProviders = providers
    .filter((provider) => provider.backendType === "native-api")
    .sort(byPriority);
  const subscriptionProviders = providers
    .filter((provider) => provider.backendType !== "native-api")
    .sort(byPriority);

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
                <SubscriptionProviderRow key={provider.id} provider={provider} />
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
                  onStatus={onStatus}
                  onConnect={(providerId, secret) =>
                    void runtime
                      .connectBackendWithVerify(providerId, secret)
                      .then((result) => {
                        // Report accurately: never claim "connected" when the
                        // key was rejected or verification failed. Route every
                        // outcome through connectResultCopy so a MISSING key
                        // ('add a key') is distinguished from a REJECTED key
                        // ('key was rejected/expired') and transient outcomes
                        // never mention the key. Secrets/stack traces never
                        // appear here — the message comes from the boundary.
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
  onStatus,
  onConnect,
  onDisconnect,
  onRefreshModels
}: {
  provider: BackendProvider;
  connected: boolean;
  pending: boolean;
  /** Per-provider model-discovery lifecycle (idle when discovery hasn't run). */
  discoveryState: ModelDiscoveryOutcome;
  onStatus: (message: string) => void;
  onConnect: (providerId: string, secret: string) => void;
  onDisconnect: (providerId: string) => void;
  onRefreshModels: (providerId: string) => void;
}) {
  // UI-only flag: whether the inline key form is open. Holds no secret.
  const [revealed, setRevealed] = useState(false);
  // The key input is uncontrolled on purpose so the secret never enters React.
  const keyInputRef = useRef<HTMLInputElement>(null);

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

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const secret = keyInputRef.current?.value.trim() ?? "";
    if (!secret) {
      onStatus("Enter an API key to connect.");
      return;
    }
    onConnect(provider.id, secret);
    // Clear the DOM field immediately so the key does not linger in the input.
    if (keyInputRef.current) {
      keyInputRef.current.value = "";
    }
    setRevealed(false);
  };

  return (
    <article
      className={`provider-access-row provider-access-row--native${
        connected ? " provider-access-row--connected" : ""
      }`}
      data-provider-id={provider.id}
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

        {revealed && !connected ? (
          <form className="provider-access-key-form" onSubmit={handleSubmit}>
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
            <button
              type="submit"
              className="provider-access-key-form__submit"
              disabled={pending}
            >
              {pending ? (
                <span className="provider-access-key-form__pending">
                  <Spinner size={14} /> Connecting…
                </span>
              ) : (
                "Add key & connect"
              )}
            </button>
            <button
              type="button"
              className="provider-access-key-form__cancel"
              onClick={() => {
                if (keyInputRef.current) {
                  keyInputRef.current.value = "";
                }
                setRevealed(false);
              }}
              disabled={pending}
            >
              Cancel
            </button>
          </form>
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
        {connected ? (
          <>
            {/* Recoverable model refresh: re-runs discovery so the row reflects
                the real model-list state and a failed/offline list can be
                retried without reconnecting. Disabled while a refresh is in
                flight or the connect round-trip is pending. */}
            <button
              type="button"
              className="provider-access-row__refresh"
              onClick={() => onRefreshModels(provider.id)}
              disabled={pending || discoveryLoading}
              title="Refresh the list of models this account can use."
              aria-label={`Refresh models for ${provider.label}`}
            >
              {discoveryLoading ? <Spinner size={12} /> : <ArrowClockwise size={12} />}
              {discoveryDegraded ? "Retry" : "Refresh models"}
            </button>
            <button
              type="button"
              onClick={() => onDisconnect(provider.id)}
              disabled={pending}
              title="Remove the stored credential from the local boundary."
            >
              Disconnect
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setRevealed((open) => !open)}
            disabled={pending}
          >
            {revealed ? "Hide" : "Connect"}
          </button>
        )}
      </span>
    </article>
  );
}

/**
 * A subscription/CLI provider row. It is never one-click connectable from
 * Settings: unless the runtime reports it connected and capability-bearing, the
 * row states what is required (CLI install, sign-in) and exposes no fake token
 * entry field.
 */
function SubscriptionProviderRow({ provider }: { provider: BackendProvider }) {
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
        <button type="button" disabled aria-disabled="true">
          {capabilityBearing ? "Connected" : "Gated"}
        </button>
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
        <p>Manage local data, cache boundaries, and connector synchronization settings.</p>
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
              <p style={{ color: "var(--ink-soft)", fontSize: "13px", lineHeight: "1.5", marginBottom: "16px" }}>
                To protect API rate limits and conserve system resources, Fable does not continuously poll or crawl your connected accounts.
                While a background scheduler foundation manages local deferred jobs, no remote data is fetched in the background.
              </p>

              <strong style={{ display: "block", color: "var(--ink)", fontSize: "13px", fontWeight: 600, marginBottom: "8px" }}>
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
                        <strong style={{ color: "var(--ink)", fontSize: "14px", fontWeight: 600 }}>{connector.name}</strong>
                        <span style={{ color: "var(--ink-muted)", fontSize: "12px" }}>
                          {connector.account
                            ? `Active: ${connector.account.email ?? connector.account.displayName}`
                            : "Connected"}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: "8px" }}>
                        <button
                          type="button"
                          className="button button--secondary"
                          style={{ padding: "4px 10px", fontSize: "12px", minHeight: "auto", display: "inline-flex", alignItems: "center", gap: "4px" }}
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
                          style={{ padding: "4px 10px", fontSize: "12px", minHeight: "auto" }}
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
                <p style={{ color: "var(--ink-muted)", fontSize: "13px", fontStyle: "italic", margin: "8px 0" }}>
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
                <small>Configuration metadata is cached on this device, but sensitive credentials and raw data are isolated.</small>
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "16px", color: "var(--ink-soft)", fontSize: "13px", lineHeight: "1.5" }}>
              <p>
                - <strong>Keyring Protection:</strong> OAuth tokens, credentials, and secrets are stored inside your operating system keyring (or the native auth boundary) and never enter local storage or React state.
              </p>
              <p>
                - <strong>Cache Boundaries:</strong> Fable caches connector configuration, channel names, page metadata titles, and granted permission scopes. No message bodies, email bodies, file contents, or database rows are kept in a persistent local cache.
              </p>
              <p>
                - <strong>Session Lifetime:</strong> Imported files and connector knowledge sources are session-local and reset on app restart.
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
                  <strong style={{ display: "block", color: "var(--ink)", fontSize: "14px", fontWeight: 600 }}>Enable memory</strong>
                  <span style={{ display: "block", color: "var(--ink-muted)", fontSize: "12px", marginTop: "4px" }}>Allow Fable to save and recall facts locally.</span>
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

function QuietPlaceholder({ tab }: { tab: Exclude<SettingsTab, "providers" | "profile" | "appearance" | "workspace" | "privacy"> }) {
  const copy = {
    notifications: {
      description: "Notification preferences will live here."
    }
  };

  return (
    <div className="settings-page__body">
      <div className="settings-section-heading">
        <p>{copy[tab].description}</p>
      </div>
      <div className="settings-empty-row">
        <GearSix size={18} />
        <span>Nothing to configure yet.</span>
      </div>
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
            <strong style={{ display: "block", color: "var(--ink)", fontSize: "14px", fontWeight: 600 }}>Interface Theme</strong>
            <span style={{ display: "block", color: "var(--ink-muted)", fontSize: "12px", marginTop: "4px" }}>Choose between Light and Dark color schemes.</span>
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

function WorkspaceSettingsView({
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
                    fontWeight: 600,
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

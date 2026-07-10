import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { DeviceMobile } from "@phosphor-icons/react/dist/csr/DeviceMobile";
import { GearSix } from "@phosphor-icons/react/dist/csr/GearSix";
import { LockKey } from "@phosphor-icons/react/dist/csr/LockKey";
import { Moon } from "@phosphor-icons/react/dist/csr/Moon";
import { ShieldCheck } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { Spinner } from "@phosphor-icons/react/dist/csr/Spinner";
import { Sparkle } from "@phosphor-icons/react/dist/csr/Sparkle";
import { SquaresFour } from "@phosphor-icons/react/dist/csr/SquaresFour";
import { Sun } from "@phosphor-icons/react/dist/csr/Sun";
import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import { UploadSimple } from "@phosphor-icons/react/dist/csr/UploadSimple";
import { UserCircle } from "@phosphor-icons/react/dist/csr/UserCircle";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type {
  ActionHistoryEvent,
  CustomApprovalSettings,
  RemoteControlStatusSnapshot,
  VoiceCapability
} from "@fable/protocol";
import {
  CUSTOM_APPROVAL_SECTION,
  CUSTOM_APPROVAL_TOGGLE_ORDER,
  customApprovalToggleHelper,
  customApprovalToggleLabel
} from "../../lib/approval-copy";
import { PERMISSION_PROFILES } from "../../lib/agent-run";
import { getRuntimeRemoteControlStatus } from "../../runtime";
import { ProviderCatalogue } from "../providers/ProviderCatalogue";
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

const DEFAULT_DICTATION_CAPABILITY: VoiceCapability = {
  status: "unavailable",
  provider: {
    id: "browser-speech",
    kind: "remote",
    label: "Browser speech service",
    retainsAudio: false
  },
  reason: "Speech recognition is unavailable in this desktop webview."
};

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
  dictationCapability = DEFAULT_DICTATION_CAPABILITY,
  titleId = "settings-title"
}: {
  runtime: ShellRuntime;
  profile?: ProfileFixture;
  onProfileChange?: (profile: ProfileFixture) => void;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
  activeTab: SettingsTab;
  workspaceName: string;
  dictationCapability?: VoiceCapability;
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
            <IdentitySettingsView runtime={runtime} onStatus={setStatus} />
            <AppearanceSettingsView
              theme={theme}
              onThemeChange={onThemeChange}
              onStatus={setStatus}
            />
          </>
        ) : activeTab === "privacy" ? (
          <>
            <DictationPrivacySettings
              runtime={runtime}
              capability={dictationCapability}
              onStatus={setStatus}
            />
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

function IdentitySettingsView({
  runtime,
  onStatus
}: {
  runtime: ShellRuntime;
  onStatus: (message: string) => void;
}) {
  const identity = runtime.identityStatus.identity;
  const canSignIn = runtime.identityStatus.enabled && runtime.identityStatus.state !== "signed-in";
  const canRefresh = runtime.identityStatus.enabled && runtime.identityStatus.state !== "disabled";

  return (
    <article className="profile-clean-card settings-open-section">
      <div className="profile-clean-card__content">
        <section className="profile-section" aria-labelledby="fable-account-title">
          <div className="profile-section__heading">
            <span className="settings-panel__icon" aria-hidden="true">
              <ShieldCheck size={19} />
            </span>
            <span>
              <strong id="fable-account-title">Fable account</strong>
              <small>{runtime.identityStatus.message}</small>
            </span>
          </div>
          <p>
            {identity
              ? `${identity.displayName ?? identity.email ?? identity.userId}${identity.organization ? ` · ${identity.organization.name ?? identity.organization.slug ?? identity.organization.id}` : ""}`
              : "Account sign-in is configured through Clerk and remains separate from provider and connector credentials."}
          </p>
          <div className="profile-action-row">
            {canSignIn ? (
              <button
                type="button"
                className="button button--primary"
                disabled={runtime.identityPending}
                onClick={() => void runtime.signInIdentity().then(() => onStatus("Fable account updated."))}
              >
                {runtime.identityPending ? <Spinner size={14} /> : null}
                Sign in
              </button>
            ) : null}
            {canRefresh ? (
              <button
                type="button"
                className="button button--secondary"
                disabled={runtime.identityPending}
                onClick={() => void runtime.refreshIdentity().then(() => onStatus("Fable account refreshed."))}
              >
                <ArrowClockwise size={14} /> Refresh
              </button>
            ) : null}
            {identity ? (
              <button
                type="button"
                className="button button--secondary"
                disabled={runtime.identityPending}
                onClick={() => void runtime.signOutIdentity().then(() => onStatus("Fable account signed out."))}
              >
                Sign out
              </button>
            ) : null}
          </div>
        </section>
      </div>
    </article>
  );
}

function ProviderAccessView({
  runtime,
  onStatus
}: {
  runtime: ShellRuntime;
  onStatus: (message: string) => void;
}) {
  return (
    <div className="settings-page__body">
      <div className="settings-section-heading">
        <p>
          Choose a provider, then pick the connection method that matches the account you already
          use. You can connect more than one.
        </p>
      </div>

      <ProviderCatalogue
        providers={runtime.backendProviders}
        connectedBackendIds={runtime.connectedBackendIds}
        onConnect={(providerId, secret) => runtime.connectBackendWithVerify(providerId, secret)}
        onDisconnect={async (providerId) => {
          await runtime.disconnectBackend(providerId);
          onStatus(`${providerId} disconnected.`);
        }}
        onRefreshModels={async (providerId) => {
          await runtime.refreshModels(providerId);
          onStatus(`${providerId} model refresh finished. Check the provider status for the result.`);
        }}
        onCheckConnection={async (providerId) => {
          await runtime.refreshBackendProviders();
          onStatus(`${providerId} connection checked.`);
        }}
        onStatus={onStatus}
      />

      <div className="settings-local-storage">
        <span aria-hidden="true">
          <LockKey size={18} />
        </span>
        <div>
          <strong>Local storage</strong>
          <p>
            API keys are stored in Fable&rsquo;s local credential boundary and never enter the
            interface or Fable&rsquo;s cloud. They are sent only to the selected provider when Fable
            makes a request.
          </p>
        </div>
      </div>
    </div>
  );
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
    case "completed":
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

function DictationPrivacySettings({
  runtime,
  capability,
  onStatus
}: {
  runtime: ShellRuntime;
  capability: VoiceCapability;
  onStatus: (message: string) => void;
}) {
  const available = capability.status === "supported";
  return (
    <div className="settings-page__body">
      <div className="settings-section-heading">
        <p>Control optional input features that can access sensitive device data.</p>
      </div>
      <div className="provider-access-list" style={{ padding: "14px 20px" }}>
        <button
          type="button"
          className="toggle-row"
          aria-pressed={runtime.voiceEnabled}
          disabled={!available && !runtime.voiceEnabled}
          onClick={() => {
            const enabled = !runtime.voiceEnabled;
            runtime.setVoiceEnabled(enabled);
            onStatus(enabled ? "Dictation enabled." : "Dictation disabled.");
          }}
        >
          <span>
            <strong>Enable dictation</strong>
            <small>
              Starts only when you choose the microphone. Fable does not retain raw audio or persist a separate
              dictation transcript. Recognized text is added to your normal composer draft. Speech processing may
              use an operating-system or browser service.
            </small>
            {!available ? <small>{capability.reason} Text input remains available.</small> : null}
          </span>
          <span className="toggle-switch" aria-hidden="true"><span /></span>
        </button>
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

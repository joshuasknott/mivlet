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
import { UserCircle } from "@phosphor-icons/react/dist/csr/UserCircle";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AccountPendingInvitation,
  AccountWorkspaceMemberAction,
  AccountWorkspaceMemberSummary,
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
import {
  acceptRuntimePendingInvitation,
  createRuntimeLocalBackup,
  getRuntimeRemoteControlStatus,
  loadRuntimeExecutionControl,
  loadRuntimeLocalDiagnostics,
  loadRuntimePendingInvitations,
  pauseRuntimeExecution,
  prepareRuntimeLocalRestore,
  resumeRuntimeExecution,
  type RuntimeExecutionControlState,
  type RuntimeLocalDiagnosticsSnapshot
} from "../../runtime";
import { ProviderCatalogue } from "../providers/ProviderCatalogue";
import { RunHistoryPage } from "./RunHistoryPage";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import { useWorkspaceMembers } from "../../hooks/useWorkspaceMembers";
import { LocalMcpSettings } from "../settings/LocalMcpSettings";

// Re-export the eager-loadable tab metadata so the lazy-loaded page module
// remains the single source of truth for existing direct importers. The
// lightweight `settings-tabs.ts` is what callers that only need the tab list
// should import, so they don't pull this heavy module into the initial bundle.
export type { SettingsTab } from "./settings-tabs";
export { tabs } from "./settings-tabs";
import { tabs } from "./settings-tabs";
import type { SettingsTab } from "./settings-tabs";

type WorkspaceRole = AccountWorkspaceMemberSummary["role"];

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
  theme,
  onThemeChange,
  activeTab,
  workspaceName,
  dictationCapability = DEFAULT_DICTATION_CAPABILITY,
  titleId = "settings-title"
}: {
  runtime: ShellRuntime;
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
  const authentication = runtime.identityStatus.authentication;
  const display = authentication?.verifiedDisplayAttributes;
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null);
  const [deviceToRevoke, setDeviceToRevoke] = useState<string | null>(null);
  const identityState = runtime.identityStatus.state;
  const workspaceState = runtime.accountWorkspaceStatus.state;
  const needsRecovery = identityState === "expired" || identityState === "revoked" || workspaceState === "expired" || workspaceState === "revoked";
  const canSignIn = runtime.identityStatus.enabled && !authentication && !needsRecovery;
  const canRefresh = runtime.identityStatus.enabled && identityState !== "disabled";
  const accountMessage = runtime.accountWorkspaceStatus.message || runtime.identityStatus.message;

  const accountStateLabel = (() => {
    if (!runtime.identityStatus.enabled || !runtime.accountWorkspaceStatus.configured) return "Configuration required";
    if (needsRecovery) return identityState === "revoked" || workspaceState === "revoked" ? "Account access revoked" : "Session expired";
    if (identityState === "offline" || workspaceState === "offline") return "Offline";
    if (runtime.identityPending || runtime.accountWorkspacePending || identityState === "refreshing" || workspaceState === "bootstrapping") return "Checking your account";
    if (identityState === "error" || workspaceState === "error") return "Account needs attention";
    return authentication && workspaceState === "ready" ? "Ready" : "Signed out";
  })();

  const handle = async (action: () => Promise<void>, success: string) => {
    try {
      await action();
      onStatus(success);
    } catch {
      onStatus("That didn’t work. Check your connection and try again.");
    }
  };

  const confirmDeviceRemoval = async () => {
    const device = runtime.accountWorkspaceStatus.devices.find((candidate) => candidate.deviceId === deviceToRevoke);
    if (!device) return;
    setRevokingDeviceId(device.deviceId);
    try {
      await runtime.revokeAccountDevice(device.deviceId);
      onStatus(`${device.label} removed.`);
      setDeviceToRevoke(null);
    } catch {
      onStatus("That device could not be removed. Try again.");
    } finally {
      setRevokingDeviceId(null);
    }
  };

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
              <small>{accountStateLabel} · {accountMessage}</small>
            </span>
          </div>
          <p>
            {authentication
              ? display?.displayName ?? display?.email ?? authentication.subject
              : "Use your Fable account to open your workspace. Your password stays in the system browser."}
          </p>
          <div className="profile-action-row">
            {canSignIn ? (
              <button
                type="button"
                className="button button--primary"
                disabled={runtime.identityPending || runtime.accountWorkspacePending}
                onClick={() => void handle(runtime.signInIdentity, "Fable sign-in started in your browser.")}
              >
                {runtime.identityPending ? <Spinner size={14} /> : null}
                Sign in
              </button>
            ) : null}
            {needsRecovery ? (
              <button
                type="button"
                className="button button--primary"
                disabled={runtime.identityPending || runtime.accountWorkspacePending}
                onClick={() => void handle(runtime.recoverIdentity, "Account recovery started in your browser.")}
              >
                {runtime.identityPending ? <Spinner size={14} /> : null}
                Recover account
              </button>
            ) : null}
            {canRefresh ? (
              <button
                type="button"
                className="button button--secondary"
                disabled={runtime.identityPending || runtime.accountWorkspacePending}
                onClick={() => void handle(async () => {
                  await runtime.refreshIdentity();
                  await runtime.reconcileAccountWorkspace();
                }, "Fable account refreshed.")}
              >
                <ArrowClockwise size={14} /> Refresh
              </button>
            ) : null}
            {authentication ? (
              <button
                type="button"
                className="button button--secondary"
                disabled={runtime.identityPending || runtime.accountWorkspacePending}
                onClick={() => void handle(runtime.signOutIdentity, "Fable account signed out.")}
              >
                Sign out
              </button>
            ) : null}
          </div>
        </section>
        <section className="profile-section" aria-labelledby="account-devices-title">
          <div className="profile-section__heading">
            <span className="settings-panel__icon" aria-hidden="true"><DeviceMobile size={19} /></span>
            <span>
              <strong id="account-devices-title">Your devices</strong>
              <small>Remove a device if you no longer use it. Removed devices stay removed; reconnect from a new device if needed.</small>
            </span>
          </div>
          {runtime.accountWorkspaceStatus.devices.length > 0 ? (
            <div className="provider-access-list">
              {runtime.accountWorkspaceStatus.devices.map((device) => (
                <div className="provider-access-row" key={device.deviceId}>
                  <span>
                    <strong>{device.label}</strong>
                    <small>{device.kind} · {device.status === "active" ? "Available" : device.status === "pending" ? "Waiting to finish setup" : "Removed"}</small>
                  </span>
                  {device.status !== "revoked" ? (
                    <button
                      type="button"
                      className="button button--secondary"
                      disabled={revokingDeviceId === device.deviceId || runtime.accountWorkspacePending}
                      onClick={() => setDeviceToRevoke(device.deviceId)}
                    >
                      {revokingDeviceId === device.deviceId ? "Removing…" : "Remove device"}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : <p>No devices are available yet.</p>}
        </section>
        {deviceToRevoke ? (() => {
          const device = runtime.accountWorkspaceStatus.devices.find((candidate) => candidate.deviceId === deviceToRevoke);
          return device ? (
            <section className="settings-confirmation" role="dialog" aria-modal="true" aria-labelledby="remove-device-title">
              <strong id="remove-device-title">Remove {device.label}?</strong>
              <p>This device will lose access to Fable. Removed devices stay removed; reconnect from a new device if needed.</p>
              <div className="profile-action-row">
                <button type="button" className="button button--secondary" autoFocus onClick={() => setDeviceToRevoke(null)}>Keep device</button>
                <button type="button" className="button button--destructive" disabled={revokingDeviceId === device.deviceId} onClick={() => void confirmDeviceRemoval()}>
                  {revokingDeviceId === device.deviceId ? "Removing…" : "Remove device"}
                </button>
              </div>
            </section>
          ) : null;
        })() : null}
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
          const result = await runtime.checkBackendConnection(providerId);
          onStatus(`${providerId} connection checked.`);
          return result;
        }}
        onStatus={onStatus}
      />

      <LocalMcpSettings
        workspaceId={runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId}
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
  const [backupPath, setBackupPath] = useState("");
  const [restorePath, setRestorePath] = useState("");
  const [restoreConfirmation, setRestoreConfirmation] = useState("");
  const [recoveryAction, setRecoveryAction] = useState<"backup" | "restore" | null>(null);
  const [diagnostics, setDiagnostics] = useState<RuntimeLocalDiagnosticsSnapshot | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [executionControl, setExecutionControl] = useState<RuntimeExecutionControlState | null>(null);
  const [executionConfirmation, setExecutionConfirmation] = useState("");
  const [executionControlLoading, setExecutionControlLoading] = useState(false);
  const workspaceId = runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId;

  useEffect(() => {
    let current = true;
    setExecutionControl(null);
    setExecutionConfirmation("");
    void loadRuntimeExecutionControl(workspaceId)
      .then((state) => {
        if (current) setExecutionControl(state);
      })
      .catch(() => {
        if (current) setExecutionControl(null);
      });
    return () => {
      current = false;
    };
  }, [workspaceId]);

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

  const handleBackup = async () => {
    if (!backupPath.trim()) return;
    setRecoveryAction("backup");
    try {
      const receipt = await createRuntimeLocalBackup(backupPath.trim());
      onStatus(receipt
        ? "Encrypted recovery backup created and verified. Keep it with this device's OS account key."
        : "Encrypted recovery backups are available only in the Fable desktop app.");
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Fable could not create that backup.");
    } finally {
      setRecoveryAction(null);
    }
  };

  const handleRestore = async () => {
    if (!restorePath.trim() || restoreConfirmation !== "restore local data") return;
    setRecoveryAction("restore");
    try {
      const prepared = await prepareRuntimeLocalRestore(
        restorePath.trim(),
        "restore local data"
      );
      if (prepared) {
        setRestoreConfirmation("");
        onStatus("Backup verified. Restart Fable to apply it; the current database will be kept as a recovery point.");
      } else {
        onStatus("Local restore is available only in the Fable desktop app.");
      }
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Fable could not prepare that restore.");
    } finally {
      setRecoveryAction(null);
    }
  };

  const handleDiagnostics = async () => {
    setDiagnosticsLoading(true);
    try {
      const snapshot = await loadRuntimeLocalDiagnostics(
        runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId
      );
      setDiagnostics(snapshot);
      onStatus(snapshot
        ? "Local health check complete. The report contains statuses and counts only."
        : "Local health checks are available only in the Fable desktop app.");
    } catch (error) {
      setDiagnostics(null);
      onStatus(error instanceof Error ? error.message : "Fable could not run the local health check.");
    } finally {
      setDiagnosticsLoading(false);
    }
  };

  const handleExecutionControl = async () => {
    if (!executionControl) return;
    const expected = executionControl.paused ? "resume execution" : "pause all execution";
    if (executionConfirmation !== expected) return;
    setExecutionControlLoading(true);
    try {
      const next = executionControl.paused
        ? await resumeRuntimeExecution(workspaceId, executionControl.revision, "resume execution")
        : await pauseRuntimeExecution(workspaceId, "pause all execution");
      setExecutionControl(next);
      setExecutionConfirmation("");
      onStatus(next?.paused
        ? "New provider, tool, Mission, and scheduled execution is paused for this workspace."
        : next
          ? "New execution is available again. Existing approval and budget boundaries still apply."
          : "Workspace execution control is available only in the Fable desktop app.");
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Fable could not change execution control.");
    } finally {
      setExecutionControlLoading(false);
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

          <section className="profile-section" aria-labelledby="local-recovery-title">
            <div className="profile-section__heading">
              <span className="settings-panel__icon" aria-hidden="true">
                <LockKey size={19} />
              </span>
              <span>
                <strong id="local-recovery-title">Local recovery</strong>
                <small>Create or restore a verified encrypted copy of Fable&rsquo;s local data.</small>
              </span>
            </div>
            <div style={{ display: "grid", gap: "18px", marginTop: "16px" }}>
              <div style={{ display: "grid", gap: "8px" }}>
                <label htmlFor="local-backup-path"><strong>New backup file</strong></label>
                <input
                  id="local-backup-path"
                  className="input"
                  value={backupPath}
                  onChange={(event) => setBackupPath(event.target.value)}
                  placeholder="Choose a new .db file path"
                  spellCheck={false}
                  autoComplete="off"
                />
                <small>
                  The backup contains encrypted local data, artifacts, and settings. Provider credentials stay in the OS credential store and are not included.
                </small>
                <div>
                  <button
                    type="button"
                    className="button button--secondary"
                    onClick={() => void handleBackup()}
                    disabled={!backupPath.trim() || recoveryAction !== null}
                  >
                    {recoveryAction === "backup" ? <Spinner size={14} /> : null}
                    <span>Create verified backup</span>
                  </button>
                </div>
              </div>
              <div style={{ display: "grid", gap: "8px" }}>
                <label htmlFor="local-restore-path"><strong>Restore from backup</strong></label>
                <input
                  id="local-restore-path"
                  className="input"
                  value={restorePath}
                  onChange={(event) => setRestorePath(event.target.value)}
                  placeholder="Existing Fable backup .db file"
                  spellCheck={false}
                  autoComplete="off"
                />
                <label htmlFor="local-restore-confirmation">
                  Type <strong>restore local data</strong> to confirm
                </label>
                <input
                  id="local-restore-confirmation"
                  className="input"
                  value={restoreConfirmation}
                  onChange={(event) => setRestoreConfirmation(event.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
                <small>
                  Fable verifies the database and matching OS-held key first. It applies only after restart and preserves the current database as a recovery point.
                </small>
                <div>
                  <button
                    type="button"
                    className="button button--destructive"
                    onClick={() => void handleRestore()}
                    disabled={
                      !restorePath.trim()
                      || restoreConfirmation !== "restore local data"
                      || recoveryAction !== null
                    }
                  >
                    {recoveryAction === "restore" ? <Spinner size={14} /> : null}
                    <span>Verify and prepare restore</span>
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section className="profile-section" aria-labelledby="execution-control-title">
            <div className="profile-section__heading">
              <span className="settings-panel__icon" aria-hidden="true">
                <ShieldCheck size={19} />
              </span>
              <span>
                <strong id="execution-control-title">Pause new execution</strong>
                <small>Stop Fable from starting more provider, tool, Mission, Routine, or scheduled work in this workspace.</small>
              </span>
            </div>
            <div style={{ display: "grid", gap: "10px", marginTop: "16px" }}>
              {executionControl ? (
                <>
                  <div className="provider-access-row">
                    <span>
                      <strong>{executionControl.paused ? "Execution paused" : "Execution available"}</strong>
                      <small>
                        {executionControl.paused
                          ? "New work and scheduler leases are blocked. Already accepted external effects cannot be undone here."
                          : "Normal approvals, grants, budgets, and cancellation rules still apply."}
                      </small>
                    </span>
                    <span className={`status-pill status-pill--${executionControl.paused ? "attention" : "healthy"}`}>
                      {executionControl.paused ? "Paused" : "Ready"}
                    </span>
                  </div>
                  <label htmlFor="execution-control-confirmation">
                    Type <strong>{executionControl.paused ? "resume execution" : "pause all execution"}</strong> to confirm
                  </label>
                  <input
                    id="execution-control-confirmation"
                    className="input"
                    value={executionConfirmation}
                    onChange={(event) => setExecutionConfirmation(event.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <div>
                    <button
                      type="button"
                      className={executionControl.paused ? "button button--secondary" : "button button--destructive"}
                      onClick={() => void handleExecutionControl()}
                      disabled={
                        executionControlLoading
                        || executionConfirmation !== (executionControl.paused
                          ? "resume execution"
                          : "pause all execution")
                      }
                    >
                      {executionControlLoading ? <Spinner size={14} /> : null}
                      <span>{executionControl.paused ? "Resume new execution" : "Pause new execution"}</span>
                    </button>
                  </div>
                </>
              ) : (
                <small>This control is available only in the signed-in Fable desktop runtime.</small>
              )}
            </div>
          </section>

          <section className="profile-section" aria-labelledby="support-diagnostics-title">
            <div className="profile-section__heading">
              <span className="settings-panel__icon" aria-hidden="true">
                <ShieldCheck size={19} />
              </span>
              <span>
                <strong id="support-diagnostics-title">Local health check</strong>
                <small>Review storage and execution health without exposing your content or credentials.</small>
              </span>
            </div>
            <div style={{ display: "grid", gap: "12px", marginTop: "16px" }}>
              <div>
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => void handleDiagnostics()}
                  disabled={diagnosticsLoading}
                >
                  {diagnosticsLoading ? <Spinner size={14} /> : null}
                  <span>{diagnostics ? "Run again" : "Run local health check"}</span>
                </button>
              </div>
              {diagnostics ? (
                <div className="provider-access-list" aria-label="Local health check results">
                  {diagnostics.categories.map((entry) => (
                    <div className="provider-access-row" key={entry.id}>
                      <span>
                        <strong>{entry.label}</strong>
                        <small>{entry.summary}</small>
                      </span>
                      <span className={`status-pill status-pill--${entry.status}`}>
                        {entry.status === "healthy"
                          ? "Ready"
                          : entry.status === "attention"
                            ? "Needs attention"
                            : "Not configured"}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              <small>
                This check returns bounded counts and health states only. It does not read saved prompts, artifacts, citations, provider responses, file paths, account identifiers, or secrets.
              </small>
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
  fableWorkspaceId = null,
  accountContextKey = "standalone",
  onStatus,
  onInvitationAccepted
}: {
  workspaceName: string;
  fableWorkspaceId?: string | null;
  accountContextKey?: string;
  onStatus: (message: string) => void;
  onInvitationAccepted: () => void | Promise<void>;
}) {
  const [invitations, setInvitations] = useState<readonly AccountPendingInvitation[]>([]);
  const [invitationState, setInvitationState] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [invitationMessage, setInvitationMessage] = useState("");
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  const acceptanceTokenRef = useRef<symbol | null>(null);
  const mountedRef = useRef(true);
  const members = useWorkspaceMembers({ accountContextKey, fableWorkspaceId });
  const memberContextKey = useMemo(
    () => JSON.stringify([accountContextKey, fableWorkspaceId]),
    [accountContextKey, fableWorkspaceId]
  );
  const [roleDrafts, setRoleDrafts] = useState<Record<string, WorkspaceRole>>({});
  const [removeConfirmation, setRemoveConfirmation] = useState<{
    contextKey: string;
    member: AccountWorkspaceMemberSummary;
  } | null>(null);
  const [memberMessage, setMemberMessage] = useState<{ contextKey: string; text: string } | null>(null);
  const memberFeedbackRef = useRef<HTMLParagraphElement>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>("editor");
  const [inviteMessage, setInviteMessage] = useState<{ contextKey: string; text: string } | null>(null);
  const inviteFeedbackRef = useRef<HTMLParagraphElement>(null);

  const loadInvitations = async () => {
    setInvitationState("loading");
    setInvitationMessage("");
    try {
      const result = await loadRuntimePendingInvitations();
      if (result === null) {
        setInvitations([]);
        setInvitationState("unavailable");
      } else {
        setInvitations(result.invitations);
        setInvitationState("ready");
      }
    } catch {
      setInvitations([]);
      setInvitationState("error");
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      acceptanceTokenRef.current = null;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const result = await loadRuntimePendingInvitations();
        if (!active) return;
        if (result === null) {
          setInvitationState("unavailable");
        } else {
          setInvitations(result.invitations);
          setInvitationState("ready");
        }
      } catch {
        if (active) setInvitationState("error");
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (invitationMessage) feedbackRef.current?.focus();
  }, [invitationMessage]);

  useEffect(() => {
    setRoleDrafts({});
    setRemoveConfirmation(null);
  }, [memberContextKey, members.roster]);

  useEffect(() => {
    setInviteEmail("");
    setInviteRole("editor");
    setInviteMessage(null);
  }, [memberContextKey]);

  useEffect(() => {
    setMemberMessage(null);
  }, [memberContextKey]);

  useEffect(() => {
    if (memberMessage?.contextKey === memberContextKey) memberFeedbackRef.current?.focus();
  }, [memberContextKey, memberMessage]);

  useEffect(() => {
    if (inviteMessage?.contextKey === memberContextKey) inviteFeedbackRef.current?.focus();
  }, [inviteMessage, memberContextKey]);

  const acceptInvitation = async (invitationId: string) => {
    if (acceptanceTokenRef.current) return;
    const requestToken = Symbol(invitationId);
    acceptanceTokenRef.current = requestToken;
    setAcceptingId(invitationId);
    setInvitationMessage("");
    const isCurrent = () => mountedRef.current && acceptanceTokenRef.current === requestToken;
    try {
      const outcome = await acceptRuntimePendingInvitation(invitationId);
      if (!isCurrent()) return;
      if (outcome === null) {
        setInvitationState("unavailable");
      } else if (outcome.result.status !== "accepted") {
        setInvitationMessage("This invitation is no longer available. Refresh invitations to check again.");
      } else {
        setInvitations((current) => current.filter((entry) => entry.invitation.invitationId !== invitationId));
        try {
          await onInvitationAccepted();
          if (!isCurrent()) return;
          setInvitationMessage("Invitation accepted. The workspace is now available from the workspace selector.");
        } catch {
          if (!isCurrent()) return;
          setInvitationMessage("Invitation accepted. The workspace list couldn’t refresh yet; try refreshing your account.");
        }
      }
    } catch {
      if (!isCurrent()) return;
      setInvitationMessage("That invitation couldn’t be accepted. Check your connection and try again.");
    } finally {
      if (acceptanceTokenRef.current === requestToken) {
        acceptanceTokenRef.current = null;
        if (mountedRef.current) setAcceptingId(null);
      }
    }
  };

  const roleLabel = (role: AccountPendingInvitation["invitation"]["role"]) =>
    role === "owner" ? "Workspace owner" : role === "admin" ? "Workspace admin" : role === "editor" ? "Can edit" : "Can view";

  const memberRoleLabel = (role: WorkspaceRole) =>
    role === "owner" ? "Owner" : role === "admin" ? "Admin" : role === "editor" ? "Can edit" : "Can view";

  const blockedReasonCopy = (reason: AccountWorkspaceMemberSummary["management"]["blockedReason"]) => {
    if (reason === "current-member") return "Your own access is read-only here.";
    if (reason === "last-active-owner") return "Every workspace needs an owner. Make someone else an owner before changing this access.";
    if (reason === "owner-protected") return "Owners can only be managed by another owner.";
    if (reason === "permission-denied") return "Only workspace owners and admins can manage access.";
    return reason === "unavailable" ? "This access can’t be changed right now." : "";
  };

  const runMemberAction = async (
    member: AccountWorkspaceMemberSummary,
    action: AccountWorkspaceMemberAction,
    role?: WorkspaceRole
  ) => {
    setMemberMessage(null);
    try {
      const outcome = await members.changeMember({
        memberActionRef: member.memberActionRef,
        action,
        expectedRevision: member.revision,
        ...(role ? { role } : {})
      });
      if (!outcome) return;
      if (outcome.status === "accepted") {
        const text = action === "change-role"
          ? "Role saved."
          : action === "suspend"
            ? "Access paused."
            : action === "reactivate"
              ? "Access restored."
              : "Access removed.";
        setMemberMessage({ contextKey: memberContextKey, text });
      } else if (outcome.status === "conflict") {
        setMemberMessage({ contextKey: memberContextKey, text: "Access changed elsewhere. The list has been refreshed." });
      } else {
        const text = outcome.code === "last-active-owner"
          ? "Every workspace needs an owner. Make someone else an owner before changing this access."
          : "That access change couldn’t be completed. Nothing was changed.";
        setMemberMessage({ contextKey: memberContextKey, text });
      }
    } catch {
      setMemberMessage({ contextKey: memberContextKey, text: "That access change couldn’t be completed. Check your connection and try again." });
    }
  };

  const createInvitation = async () => {
    const capability = members.roster?.invitationManagement;
    if (!capability?.available || !capability.invitationActionRef || members.invitationPending) return;
    setInviteMessage(null);
    try {
      const outcome = await members.createInvitation({
        invitationActionRef: capability.invitationActionRef,
        email: inviteEmail,
        role: inviteRole
      });
      if (!outcome) return;
      if (outcome.status === "accepted") {
        setInviteEmail("");
        setInviteMessage({
          contextKey: memberContextKey,
          text: "Invitation created. They’ll see it when they sign in with that verified email."
        });
      } else if (outcome.status === "conflict") {
        setInviteMessage({ contextKey: memberContextKey, text: "That person already has a pending invitation." });
      } else {
        setInviteMessage({
          contextKey: memberContextKey,
          text: outcome.code === "invitation-targeting-unavailable"
            ? "Invites aren’t available in this build yet."
            : "That invitation couldn’t be created. Nothing was changed."
        });
      }
    } catch (error) {
      const message = error instanceof Error && error.message === "Enter a valid email address."
        ? error.message
        : "That invitation couldn’t be created. Check your connection and try again.";
      setInviteMessage({ contextKey: memberContextKey, text: message });
    }
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
                <small>This is the active workspace attached to your Fable account.</small>
              </span>
            </div>
            <p>{workspaceName}</p>
          </section>

          <section className="profile-section" aria-labelledby="workspace-access-title">
            <div className="profile-section__heading">
              <span className="settings-panel__icon" aria-hidden="true">
                <UserCircle size={19} />
              </span>
              <span>
                <strong id="workspace-access-title">Workspace invitations</strong>
                <small>Invitations addressed to your signed-in Fable account appear here.</small>
              </span>
            </div>
            {invitationState === "loading" ? <p role="status">Checking for invitations…</p> : null}
            {invitationState === "unavailable" ? <p className="profile-security-note">Sharing invitations require the Fable desktop account service.</p> : null}
            {invitationState === "error" ? (
              <div>
                <p role="alert">Invitations couldn’t be loaded. Check your connection and try again.</p>
                <button type="button" className="button button--secondary" onClick={() => void loadInvitations()}>Try again</button>
              </div>
            ) : null}
            {invitationState === "ready" && invitations.length === 0 ? <p>No pending invitations.</p> : null}
            {invitationState === "ready" && invitations.length > 0 ? (
              <div className="provider-access-list" aria-label="Pending workspace invitations">
                {invitations.map(({ invitation, workspaceName: invitationWorkspaceName }) => (
                  <div className="provider-access-row" key={invitation.invitationId}>
                    <span>
                      <strong>{invitationWorkspaceName}</strong>
                      <small>{roleLabel(invitation.role)} · Expires {new Date(invitation.expiresAt).toLocaleDateString()}</small>
                    </span>
                    <button type="button" className="button button--primary" aria-label={`Accept invitation to ${invitationWorkspaceName}`} disabled={acceptingId !== null} onClick={() => void acceptInvitation(invitation.invitationId)}>
                      {acceptingId === invitation.invitationId ? "Accepting…" : "Accept invitation"}
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {invitationMessage ? <p ref={feedbackRef} tabIndex={-1} role="status" className="profile-security-note">{invitationMessage}</p> : null}
          </section>

          <section className="profile-section" aria-labelledby="workspace-members-title">
            <div className="profile-section__heading">
              <span className="settings-panel__icon" aria-hidden="true">
                <UserCircle size={19} />
              </span>
              <span>
                <strong id="workspace-members-title">People with access</strong>
                <small>People connected to this workspace and their access.</small>
              </span>
            </div>
            {members.state === "loading" ? <p role="status">Loading people…</p> : null}
            {members.state === "unavailable" ? (
              <p className="profile-security-note">People with access are available in the Fable desktop app when your account is online.</p>
            ) : null}
            {members.state === "error" ? (
              <div>
                <p role="alert">People with access couldn’t be loaded. Check your connection and try again.</p>
                <button type="button" className="button button--secondary" onClick={members.reload}>Try again</button>
              </div>
            ) : null}
            {members.state === "ready" && members.roster ? (
              members.roster.invitationManagement.available && members.roster.invitationManagement.invitationActionRef ? (
                <form
                  className="workspace-invitation-form"
                  aria-label="Invite someone to this workspace"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void createInvitation();
                  }}
                >
                  <label htmlFor="workspace-invitation-email">Email</label>
                  <input
                    id="workspace-invitation-email"
                    type="email"
                    autoComplete="email"
                    value={inviteEmail}
                    disabled={members.invitationPending}
                    onChange={(event) => setInviteEmail(event.target.value)}
                    placeholder="person@example.com"
                    required
                  />
                  <label htmlFor="workspace-invitation-role">Access</label>
                  <select
                    id="workspace-invitation-role"
                    value={inviteRole}
                    disabled={members.invitationPending}
                    onChange={(event) => setInviteRole(event.target.value as WorkspaceRole)}
                  >
                    {members.roster.invitationManagement.allowedRoles.map((role) => (
                      <option value={role} key={role}>{memberRoleLabel(role)}</option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    className="button button--primary"
                    disabled={members.invitationPending || inviteEmail.trim() === ""}
                    aria-busy={members.invitationPending}
                  >
                    {members.invitationPending ? "Inviting…" : "Invite"}
                  </button>
                </form>
              ) : (
                <p className="profile-security-note">{members.roster.invitationManagement.message}</p>
              )
            ) : null}
            {inviteMessage?.contextKey === memberContextKey ? (
              <p ref={inviteFeedbackRef} tabIndex={-1} role="status" className="profile-security-note">{inviteMessage.text}</p>
            ) : null}
            {members.state === "ready" && members.roster?.members.length === 0 ? <p>No people are listed yet.</p> : null}
            {members.state === "ready" && members.roster && members.roster.members.length > 0 ? (
              <div className="workspace-member-list" aria-label="People with workspace access">
                {members.roster.members.map((member, index) => {
                  const role = memberRoleLabel(member.role);
                  const status = member.status === "active" ? "Active" : member.status === "suspended" ? "Paused" : "Removed";
                  const selectedRole = roleDrafts[member.memberActionRef] ?? member.role;
                  const roleOptions = [member.role, ...member.management.allowedRoles.filter((roleOption) => roleOption !== member.role)];
                  const statusAction = member.management.allowedActions.find((action) => action === "suspend" || action === "reactivate");
                  const canRemove = member.management.allowedActions.includes("remove");
                  const hasControls = member.management.allowedRoles.length > 0 || statusAction !== undefined || canRemove;
                  const blockedCopy = blockedReasonCopy(member.management.blockedReason);
                  const actionPending = members.pendingAction?.memberActionRef === member.memberActionRef;
                  return (
                    <div className="workspace-member-row" key={member.memberActionRef}>
                      <span className="workspace-member-row__identity">
                        <strong>
                          {member.displayName?.trim() || "Workspace member"}
                          {member.isCurrentUser ? " · You" : ""}
                        </strong>
                        <small>{member.emailHint ? `${member.emailHint} · ` : ""}{role} · {status}</small>
                      </span>
                      {hasControls ? (
                        <div className="workspace-member-row__controls">
                          {member.management.allowedRoles.length > 0 ? (
                            <div className="workspace-member-role-control">
                              <label htmlFor={`workspace-member-role-${index}`}>Role</label>
                              <select
                                id={`workspace-member-role-${index}`}
                                aria-label={`Role for ${member.displayName?.trim() || "workspace member"}`}
                                value={selectedRole}
                                disabled={members.pendingAction !== null}
                                onChange={(event) => setRoleDrafts((current) => ({
                                  ...current,
                                  [member.memberActionRef]: event.target.value as WorkspaceRole
                                }))}
                              >
                                {roleOptions.map((allowedRole) => (
                                  <option value={allowedRole} key={allowedRole}>{memberRoleLabel(allowedRole)}</option>
                                ))}
                              </select>
                              <button
                                type="button"
                                className="button button--secondary"
                                disabled={members.pendingAction !== null || selectedRole === member.role}
                                aria-busy={actionPending && members.pendingAction?.action === "change-role"}
                                onClick={() => void runMemberAction(member, "change-role", selectedRole)}
                              >
                                {actionPending && members.pendingAction?.action === "change-role" ? "Saving…" : "Save"}
                              </button>
                            </div>
                          ) : null}
                          {statusAction ? (
                            <button
                              type="button"
                              className="button button--secondary"
                              disabled={members.pendingAction !== null}
                              aria-busy={actionPending && members.pendingAction?.action === statusAction}
                              onClick={() => void runMemberAction(member, statusAction)}
                            >
                              {actionPending && members.pendingAction?.action === statusAction
                                ? statusAction === "suspend" ? "Pausing…" : "Restoring…"
                                : statusAction === "suspend" ? "Pause access" : "Restore access"}
                            </button>
                          ) : null}
                          {canRemove ? (
                            <button
                              type="button"
                              className="button button--ghost workspace-member-row__remove"
                              disabled={members.pendingAction !== null}
                              onClick={() => setRemoveConfirmation({ contextKey: memberContextKey, member })}
                            >
                              Remove
                            </button>
                          ) : null}
                        </div>
                      ) : blockedCopy ? <small className="workspace-member-row__read-only">{blockedCopy}</small> : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
            {removeConfirmation?.contextKey === memberContextKey ? (
              <section className="workspace-member-confirmation" role="dialog" aria-modal="true" aria-labelledby="remove-workspace-member-title">
                <strong id="remove-workspace-member-title">Remove {removeConfirmation.member.displayName?.trim() || "this workspace member"} from {workspaceName}?</strong>
                <p>This permanently removes their workspace access and revokes linked devices. It can’t be undone.</p>
                <div className="profile-action-row">
                  <button type="button" className="button button--secondary" autoFocus onClick={() => setRemoveConfirmation(null)}>Keep access</button>
                  <button
                    type="button"
                    className="button button--destructive"
                    disabled={members.pendingAction !== null}
                    onClick={() => {
                      const member = removeConfirmation.member;
                      setRemoveConfirmation(null);
                      void runMemberAction(member, "remove");
                    }}
                  >
                    Remove access
                  </button>
                </div>
              </section>
            ) : null}
            {memberMessage?.contextKey === memberContextKey ? (
              <p ref={memberFeedbackRef} tabIndex={-1} role="status" className="profile-security-note">{memberMessage.text}</p>
            ) : null}
          </section>
        </div>

        <footer className="profile-clean-card__footer">
          <div className="profile-action-row profile-action-row--end" style={{ width: "100%" }}>
            <button
              type="button"
              className="profile-button button button--primary"
              onClick={() => {
                onStatus("Workspace details are managed from your Fable account.");
              }}
            >
              Done
            </button>
          </div>
        </footer>
      </article>
    </div>
  );
}

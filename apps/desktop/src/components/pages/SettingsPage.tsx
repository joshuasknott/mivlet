import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { LockKey } from "@phosphor-icons/react/dist/csr/LockKey";
import { Spinner } from "@phosphor-icons/react/dist/csr/Spinner";
import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import { UserCircle } from "@phosphor-icons/react/dist/csr/UserCircle";
import { useState } from "react";
import type { VoiceCapability } from "@fable/protocol";
import type { SettingsRuntime } from "../settings/settings-runtime";
import { MemoryRecords } from "../settings/MemoryRecords";
import { LocalSchedules } from "../settings/LocalSchedules";
import {
  createRuntimeLocalBackup,
  deleteRuntimeLocalData,
  loadRuntimeLocalDiagnostics,
  prepareRuntimeLocalRestore,
  type RuntimeLocalDiagnosticsSnapshot
} from "../../runtime";
import { ProviderCatalogue } from "../providers/ProviderCatalogue";
import { ProviderModelSettings } from "../settings/ProviderModelSettings";
import { LocalMcpSettings } from "../settings/LocalMcpSettings";
import { PrivacySummary } from "../settings/PrivacyNotice";
import {
  AppearanceSettingsView,
  ApprovalsSettingsView,
  DictationPrivacySettings
} from "../settings/PreferencesSettingsViews";
import { tabs } from "./settings-tabs";
import type { SettingsTab } from "./settings-tabs";

export type { SettingsTab } from "./settings-tabs";
export { tabs } from "./settings-tabs";

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

export function SettingsPage({
  runtime,
  theme,
  onThemeChange,
  activeTab,
  workspaceName,
  dictationCapability = DEFAULT_DICTATION_CAPABILITY,
  onOpenScheduleResult,
  titleId = "settings-title"
}: {
  runtime: SettingsRuntime;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
  activeTab: SettingsTab;
  workspaceName: string;
  dictationCapability?: VoiceCapability;
  onOpenScheduleResult?: (agentId: string, threadId: string) => Promise<void>;
  titleId?: string;
}) {
  const [status, setStatus] = useState<{ tab: SettingsTab; message: string } | null>(null);
  const reportStatus = (message: string) => setStatus({ tab: activeTab, message });

  return (
    <section className="settings-page" aria-labelledby={titleId}>
      <div className="settings-page__content">
        <div className="settings-page__header">
          <h1 id={titleId}>
            {tabs.find((tab) => tab.id === activeTab)?.label ?? "Settings"}
          </h1>
        </div>

        {activeTab === "general" ? (
          <GeneralSettings
            runtime={runtime}
            workspaceName={workspaceName}
            theme={theme}
            onThemeChange={onThemeChange}
            onStatus={reportStatus}
          />
        ) : activeTab === "providers" ? (
          <ProviderSettings runtime={runtime} onStatus={reportStatus} />
        ) : activeTab === "connections" ? (
          <ConnectionSettings runtime={runtime} onStatus={reportStatus} />
        ) : activeTab === "schedules" ? (
          <LocalSchedules runtime={runtime} onOpenResult={onOpenScheduleResult} />
        ) : (
          <PrivacyAndDataSettings
            runtime={runtime}
            dictationCapability={dictationCapability}
            onStatus={reportStatus}
          />
        )}

        {status?.tab === activeTab && status.message ? (
          <p className="settings-status" role="status">
            {status.message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function GeneralSettings({
  runtime,
  workspaceName,
  theme,
  onThemeChange,
  onStatus
}: {
  runtime: SettingsRuntime;
  workspaceName: string;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
  onStatus: (message: string) => void;
}) {
  const accountConfigured =
    runtime.identityStatus.enabled && runtime.accountWorkspaceStatus.configured;

  return (
    <>
      <div className="settings-page__body">
        <div className="settings-section-heading">
          <p>Your account and workspace preferences.</p>
        </div>
        <div className="settings-preference-row"><span><strong>Local workspace</strong><small>Saved on this computer.</small></span><span>{workspaceName}</span></div></div>

      {accountConfigured ? (
        <ConfiguredAccountSettings runtime={runtime} onStatus={onStatus} />
      ) : null}

      <ApprovalsSettingsView runtime={runtime} onStatus={onStatus} />
      <AppearanceSettingsView
        theme={theme}
        onThemeChange={onThemeChange}
        onStatus={onStatus}
      />
    </>
  );
}

function ConfiguredAccountSettings({
  runtime,
  onStatus
}: {
  runtime: SettingsRuntime;
  onStatus: (message: string) => void;
}) {
  const authentication = runtime.identityStatus.authentication;
  const identityState = runtime.identityStatus.state;
  const workspaceState = runtime.accountWorkspaceStatus.state;
  const needsRecovery =
    identityState === "expired" ||
    identityState === "revoked" ||
    workspaceState === "expired" ||
    workspaceState === "revoked";
  const busy = runtime.identityPending || runtime.accountWorkspacePending;
  const display = authentication?.verifiedDisplayAttributes;

  const act = async (action: () => Promise<void>, success: string) => {
    try {
      await action();
      onStatus(success);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "The account action did not finish.");
    }
  };

  return (
    <div className="settings-page__body">
      <article className="profile-clean-card settings-open-section">
        <div className="profile-clean-card__content">
          <section className="profile-section" aria-labelledby="fable-account-title">
            <div className="profile-section__heading">
              <span className="settings-panel__icon" aria-hidden="true">
                <UserCircle size={19} />
              </span>
              <span>
                <strong id="fable-account-title">Mivlet account</strong>
                <small>{runtime.identityStatus.message}</small>
              </span>
            </div>
            <p>
              {authentication
                ? display?.email ?? display?.displayName ?? "Signed in"
                : "Sign in to use Mivlet on this device."}
            </p>
            <div className="profile-action-row">
              {!authentication && !needsRecovery ? (
                <button
                  type="button"
                  className="button button--primary"
                  disabled={busy}
                  onClick={() => void act(runtime.signInIdentity, "Sign-in opened in your browser.")}
                >
                  {busy ? <Spinner size={14} /> : null}
                  Sign in
                </button>
              ) : null}
              {needsRecovery ? (
                <button
                  type="button"
                  className="button button--primary"
                  disabled={busy}
                  onClick={() => void act(runtime.recoverIdentity, "Account recovery opened in your browser.")}
                >
                  {busy ? <Spinner size={14} /> : null}
                  Recover
                </button>
              ) : null}
              <button
                type="button"
                className="button button--secondary"
                disabled={busy}
                onClick={() => void act(runtime.refreshIdentity, "Account status refreshed.")}
              >
                <ArrowClockwise size={14} />
                Refresh
              </button>
              {authentication ? (
                <button
                  type="button"
                  className="button button--secondary"
                  disabled={busy}
                  onClick={() => void act(runtime.signOutIdentity, "Signed out of Mivlet.")}
                >
                  Sign out
                </button>
              ) : null}
            </div>
          </section>
        </div>
      </article>
    </div>
  );
}

function ProviderSettings({
  runtime,
  onStatus
}: {
  runtime: SettingsRuntime;
  onStatus: (message: string) => void;
}) {
  return (
    <div className="settings-page__body">
      <div className="settings-section-heading">
        <p>Connect at least one model provider for conversations.</p>
      </div>
      <ProviderCatalogue
        providers={runtime.backendProviders}
        connectedBackendIds={runtime.connectedBackendIds}
        onConnect={(providerId, secret) =>
          runtime.connectBackendWithVerify(providerId, secret)
        }
        onDisconnect={async (providerId) => {
          await runtime.disconnectBackend(providerId);
          onStatus(providerId + " disconnected.");
        }}
        onRefreshModels={async (providerId) => {
          await runtime.refreshModels(providerId);
          onStatus(providerId + " models refreshed.");
        }}
        onCheckConnection={async (providerId) => {
          const result = await runtime.checkBackendConnection(providerId);
          onStatus(providerId + " connection checked.");
          return result;
        }}
        onStartBrowserLogin={(providerId) => runtime.startBackendBrowserLogin(providerId)}
        onStatus={onStatus}
      />
      <details className="settings-disclosure"><summary>Available models</summary>
      <ProviderModelSettings models={runtime.allModelOptions ?? []} hiddenModelIds={runtime.hiddenModelIds ?? []} onChange={runtime.setModelVisible} />
      </details>
      <div className="settings-local-storage">
        <span aria-hidden="true">
          <LockKey size={18} />
        </span>
        <div>
          <strong>Connected securely</strong>
          <p>
            Your provider handles model access and billing. Mivlet keeps connection credentials in your device&apos;s secure storage.
          </p>
        </div>
      </div>
    </div>
  );
}

function ConnectionSettings({
  runtime,
  onStatus
}: {
  runtime: SettingsRuntime;
  onStatus: (message: string) => void;
}) {
  return (
    <div className="settings-page__body">
      <div className="settings-section-heading">
        <p>
          Add custom tools with an MCP server. App connections live in Plugins.
        </p>
      </div>
      <LocalMcpSettings
        workspaceId={runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId}
        onStatus={onStatus}
      />
    </div>
  );
}

function PrivacyAndDataSettings({
  runtime,
  dictationCapability,
  onStatus
}: {
  runtime: SettingsRuntime;
  dictationCapability: VoiceCapability;
  onStatus: (message: string) => void;
}) {
  return (
    <>
      <details className="settings-disclosure">
        <summary>How Mivlet uses your data</summary>
        <PrivacySummary />
      </details>
      <MemorySettings runtime={runtime} onStatus={onStatus} />
      <DictationPrivacySettings
        runtime={runtime}
        capability={dictationCapability}
        onStatus={onStatus}
      />
      <details className="settings-disclosure">
        <summary>Manage local data</summary>
        <LocalDataSettings runtime={runtime} onStatus={onStatus} />
      </details>
    </>
  );
}

function MemorySettings({
  runtime,
  onStatus
}: {
  runtime: SettingsRuntime;
  onStatus: (message: string) => void;
}) {
  const [exporting, setExporting] = useState(false);
  const [toggling, setToggling] = useState(false);

  const exportMemory = async () => {
    setExporting(true);
    try {
      await runtime.exportMemory();
      onStatus("Local memory exported.");
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Mivlet could not export memory.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="settings-page__body">
      <article className="profile-clean-card settings-open-section">
        <div className="profile-clean-card__content">
          <section className="profile-section" aria-labelledby="memory-settings-title">
            <button
              type="button"
              className="toggle-row"
              aria-pressed={!runtime.memoryDisabled}
              disabled={toggling}
              onClick={() => {
                setToggling(true);
                void runtime.toggleMemoryDisabled().catch((error) => onStatus(error instanceof Error ? error.message : "Memory could not be changed.")).finally(() => setToggling(false));
              }}
            >
              <span>
                <strong id="memory-settings-title">Personal memory</strong>
                <small>Let agents recall facts you have approved.</small>
              </span>
              <span className="toggle-switch" aria-hidden="true">
                <span />
              </span>
            </button>
            <div className="profile-action-row">
              <button
                type="button"
                className="button button--secondary"
                disabled={exporting}
                onClick={() => void exportMemory()}
              >
                {exporting ? <Spinner size={14} /> : null}
                Export memory
              </button>
            </div>
          </section>
          <MemoryRecords runtime={runtime} />
        </div>
      </article>
    </div>
  );
}

function LocalDataSettings({
  runtime,
  onStatus
}: {
  runtime: SettingsRuntime;
  onStatus: (message: string) => void;
}) {
  const [backupPath, setBackupPath] = useState("");
  const [restorePath, setRestorePath] = useState("");
  const [restoreConfirmation, setRestoreConfirmation] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [pending, setPending] = useState<"backup" | "restore" | "diagnostics" | "delete" | null>(null);
  const [diagnostics, setDiagnostics] = useState<RuntimeLocalDiagnosticsSnapshot | null>(null);
  const workspaceId = runtime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId;

  const run = async (
    action: Exclude<typeof pending, null>,
    operation: () => Promise<void>
  ) => {
    setPending(action);
    try {
      await operation();
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "The local data action did not finish.");
    } finally {
      setPending(null);
    }
  };

  const createBackup = () =>
    run("backup", async () => {
      const receipt = await createRuntimeLocalBackup(backupPath.trim());
      onStatus(
        receipt
          ? "Encrypted backup created. Restore requires the matching operating-system vault key."
          : "Backups are available in the installed desktop app."
      );
    });

  const prepareRestore = () =>
    run("restore", async () => {
      const receipt = await prepareRuntimeLocalRestore(
        restorePath.trim(),
        "restore local data"
      );
      if (receipt) {
        setRestoreConfirmation("");
        onStatus("Backup verified. Restart Mivlet to apply it.");
      } else {
        onStatus("Restore is available in the installed desktop app.");
      }
    });

  const inspectDiagnostics = () =>
    run("diagnostics", async () => {
      const snapshot = await loadRuntimeLocalDiagnostics(workspaceId);
      setDiagnostics(snapshot);
      onStatus(
        snapshot
          ? "Local health check complete."
          : "Local health checks are available in the installed desktop app."
      );
    });

  const deleteLocalData = () =>
    run("delete", async () => {
      const receipt = await deleteRuntimeLocalData("delete local data");
      if (receipt) {
        setDeleteConfirmation("");
        onStatus(
          "Local workspace data deleted. Restart Mivlet. Provider credentials and hosted data were not removed."
        );
      } else {
        onStatus("Local data deletion is available in the installed desktop app.");
      }
    });

  const visibleDiagnostics = diagnostics?.categories;

  return (
    <div className="settings-page__body">
      <article className="profile-clean-card settings-open-section">
        <div className="profile-clean-card__content">
          <section className="profile-section" aria-labelledby="local-data-title">
            <div className="profile-section__heading">
              <span className="settings-panel__icon" aria-hidden="true">
                <LockKey size={19} />
              </span>
              <span>
                <strong id="local-data-title">Local data recovery</strong>
                <small>Keep a backup or check your workspace.</small>
              </span>
            </div>

            <label htmlFor="local-backup-path"><strong>New encrypted backup file</strong></label>
            <input
              id="local-backup-path"
              className="input"
              value={backupPath}
              onChange={(event) => setBackupPath(event.target.value)}
              placeholder="Choose a new backup file path"
              spellCheck={false}
              autoComplete="off"
            />
            <div className="profile-action-row">
              <button
                type="button"
                className="button button--secondary"
                disabled={!backupPath.trim() || pending !== null}
                onClick={() => void createBackup()}
              >
                {pending === "backup" ? <Spinner size={14} /> : null}
                Create backup
              </button>
              <button
                type="button"
                className="button button--secondary"
                disabled={pending !== null}
                onClick={() => void inspectDiagnostics()}
              >
                {pending === "diagnostics" ? <Spinner size={14} /> : null}
                Check local health
              </button>
            </div>

            {visibleDiagnostics?.length ? (
              <div className="provider-access-list" aria-label="Local health results">
                {visibleDiagnostics.map((category) => (
                  <div className="provider-access-row" key={category.id}>
                    <span>
                      <strong>{category.label}</strong>
                      <small>{category.summary}</small>
                    </span>
                    <small>{category.status}</small>
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          <section className="profile-section" aria-labelledby="restore-data-title">
            <div className="profile-section__heading">
              <span>
                <strong id="restore-data-title">Restore a backup</strong>
                <small>Verification is prepared now and applied after restart.</small>
              </span>
            </div>
            <input
              className="input"
              value={restorePath}
              onChange={(event) => setRestorePath(event.target.value)}
              placeholder="Existing backup file path"
              spellCheck={false}
              autoComplete="off"
              aria-label="Existing backup file path"
            />
            <input
              className="input"
              value={restoreConfirmation}
              onChange={(event) => setRestoreConfirmation(event.target.value)}
              placeholder="Type restore local data"
              autoComplete="off"
              aria-label="Restore confirmation"
            />
            <div className="profile-action-row">
              <button
                type="button"
                className="button button--secondary"
                disabled={
                  !restorePath.trim() ||
                  restoreConfirmation !== "restore local data" ||
                  pending !== null
                }
                onClick={() => void prepareRestore()}
              >
                {pending === "restore" ? <Spinner size={14} /> : null}
                Prepare restore
              </button>
            </div>
          </section>

          <section className="profile-section" aria-labelledby="delete-local-data-title">
            <div className="profile-section__heading">
              <span className="settings-panel__icon" aria-hidden="true">
                <Trash size={19} />
              </span>
              <span>
                <strong id="delete-local-data-title">Delete local workspace data</strong>
                <small>Provider accounts and credentials are kept separately.</small>
              </span>
            </div>
            <input
              className="input"
              value={deleteConfirmation}
              onChange={(event) => setDeleteConfirmation(event.target.value)}
              placeholder="Type delete local data"
              autoComplete="off"
              aria-label="Local deletion confirmation"
            />
            <div className="profile-action-row">
              <button
                type="button"
                className="button button--destructive"
                disabled={deleteConfirmation !== "delete local data" || pending !== null}
                onClick={() => void deleteLocalData()}
              >
                {pending === "delete" ? <Spinner size={14} /> : <Trash size={14} />}
                Delete local data
              </button>
            </div>
          </section>
        </div>
      </article>
    </div>
  );
}

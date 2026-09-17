import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { Spinner } from "@phosphor-icons/react/dist/csr/Spinner";
import { UserCircle } from "@phosphor-icons/react/dist/csr/UserCircle";
import { useState } from "react";
import type { VoiceCapability } from "@mivlet/protocol";
import type { SettingsRuntime } from "../settings/settings-runtime";
import { MemoryRecords } from "../settings/MemoryRecords";
import { ProviderCatalogue } from "../providers/ProviderCatalogue";
import { ProviderModelSettings } from "../settings/ProviderModelSettings";
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
  titleId = "settings-title"
}: {
  runtime: SettingsRuntime;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
  activeTab: SettingsTab;
  workspaceName: string;
  dictationCapability?: VoiceCapability;
  titleId?: string;
}) {
  const [status, setStatus] = useState<{ tab: SettingsTab; message: string } | null>(null);
  const reportStatus = (message: string) => setStatus({ tab: activeTab, message });

  return (
    <section className={`settings-page${activeTab === "providers" ? " settings-page--providers" : ""}`} aria-labelledby={titleId}>
      <div className="settings-page__content">
        <div className={activeTab === "providers" ? "sr-only" : "settings-page__header"}>
          {activeTab === "providers" ? <span id={titleId}>Providers</span> : <h1 id={titleId}>
            {tabs.find((tab) => tab.id === activeTab)?.label ?? "Settings"}
          </h1>}
        </div>

        {activeTab === "general" ? (
          <GeneralSettings
            runtime={runtime}
            workspaceName={workspaceName}
            theme={theme}
            onThemeChange={onThemeChange}
            onStatus={reportStatus}
            dictationCapability={dictationCapability}
          />
        ) : activeTab === "providers" ? (
          <ProviderSettings runtime={runtime} onStatus={reportStatus} />
        ) : activeTab === "models" ? (
          <ProviderModelSettings models={runtime.allModelOptions ?? []} hiddenModelIds={runtime.hiddenModelIds ?? []} onChange={runtime.setModelVisible} />

        ) : (
          <MemorySettingsPage
            runtime={runtime}
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
  dictationCapability,
  runtime,
  workspaceName,
  theme,
  onThemeChange,
  onStatus
}: {
  runtime: SettingsRuntime;
  dictationCapability: VoiceCapability;
  workspaceName: string;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
  onStatus: (message: string) => void;
}) {
  const accountConfigured =
    runtime.identityStatus.enabled && runtime.accountWorkspaceStatus.configured;

  return (
    <div className="settings-stack">
      <p className="settings-intro">Make Mivlet feel like yours.</p>
      <section className="settings-group" aria-labelledby="account-workspace-heading">
        <h2 id="account-workspace-heading">Account and workspace</h2>
        <div className="settings-group__surface">
          {accountConfigured ? <ConfiguredAccountSettings runtime={runtime} onStatus={onStatus} /> : null}
          <div className="settings-preference-row"><span><strong>Local workspace</strong><small>Saved on this computer.</small></span><span>{workspaceName}</span></div>
        </div>
      </section>
      <section className="settings-group" aria-labelledby="preferences-heading">
        <h2 id="preferences-heading">Preferences</h2>
        <div className="settings-group__surface">
          <AppearanceSettingsView theme={theme} onThemeChange={onThemeChange} onStatus={onStatus} />
          <ApprovalsSettingsView runtime={runtime} onStatus={onStatus} />
        </div>
      </section>
      <section className="settings-group" aria-labelledby="general-voice-heading"><h2 id="general-voice-heading">Voice input</h2><div className="settings-group__surface"><DictationPrivacySettings runtime={runtime} capability={dictationCapability} onStatus={onStatus} /></div></section>
    </div>
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
          <section className="profile-section" aria-labelledby="mivlet-account-title">
            <div className="profile-section__heading">
              <span className="settings-panel__icon" aria-hidden="true">
                <UserCircle size={19} />
              </span>
              <span>
                <strong id="mivlet-account-title">Mivlet account</strong>
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
  onStatus,
}: {
  runtime: SettingsRuntime;
  onStatus: (message: string) => void;
}) {
  return (
    <div className="settings-page__body">
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
        onStartBrowserLogin={(providerId) =>
          runtime.startBackendBrowserLogin(providerId)
        }
        onStatus={onStatus}
      />
    </div>
  );
}

function MemorySettingsPage({
  runtime,
  onStatus
}: {
  runtime: SettingsRuntime;
  onStatus: (message: string) => void;
}) {
  return (
    <div className="settings-stack">
      <p className="settings-intro">Choose what agents remember and manage the facts you have saved.</p>
      <section className="settings-group" aria-labelledby="privacy-memory-heading">
        <h2 id="privacy-memory-heading">Memory</h2>
        <div className="settings-group__surface"><MemorySettings runtime={runtime} onStatus={onStatus} /></div>
      </section>
    </div>
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
          <details className="settings-disclosure"><summary>Manage saved memories</summary><MemoryRecords runtime={runtime} /></details>
        </div>
      </article>
    </div>
  );
}

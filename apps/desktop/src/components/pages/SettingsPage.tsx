import {
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
 *   - Subscription/CLI providers (Codex, Cursor, Copilot, Grok) are gated until
 *     a real capability-bearing runtime adapter exists; there is no fake one-
 *     click "Connect" here.
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
  // (codex/cursor/copilot/grok) are gated until a real runtime adapter exists.
  const nativeProviders = providers.filter((provider) => provider.backendType === "native-api");
  const subscriptionProviders = providers.filter((provider) => provider.backendType !== "native-api");

  return (
    <div className="settings-page__body">
      <div className="settings-section-heading">
        <p>
          Connect API-key providers to run Fable&rsquo;s agent loop directly. Subscription and
          CLI-backed providers require their real runtime before they can be used.
        </p>
      </div>

      <div className="provider-access-list" aria-label="Provider access">
        {nativeProviders.length > 0 ? (
          nativeProviders.map((provider) => (
            <NativeProviderRow
              key={provider.id}
              provider={provider}
              connected={runtime.connectedBackendIds.includes(provider.id)}
              pending={pendingProviderId === provider.id}
              onStatus={onStatus}
              onConnect={(providerId, secret) =>
                void runtime.connectBackend(providerId, secret).then(() => {
                  onStatus(`${providerId} connected.`);
                })
              }
              onDisconnect={(providerId) =>
                void runtime.disconnectBackend(providerId).then(() => {
                  onStatus(`${providerId} disconnected.`);
                })
              }
            />
          ))
        ) : (
          <p className="provider-access-empty">No API-key providers are registered.</p>
        )}

        {subscriptionProviders.map((provider) => (
          <SubscriptionProviderRow key={provider.id} provider={provider} />
        ))}
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
  onStatus,
  onConnect,
  onDisconnect
}: {
  provider: BackendProvider;
  connected: boolean;
  pending: boolean;
  onStatus: (message: string) => void;
  onConnect: (providerId: string, secret: string) => void;
  onDisconnect: (providerId: string) => void;
}) {
  // UI-only flag: whether the inline key form is open. Holds no secret.
  const [revealed, setRevealed] = useState(false);
  // The key input is uncontrolled on purpose so the secret never enters React.
  const keyInputRef = useRef<HTMLInputElement>(null);

  const capabilities = providerCapabilityLabels(provider);
  const availableModels = provider.models.filter((model) => model.available);
  const authLabel = authStateLabel(provider.authState, "native-api");
  const capabilityBearing = connected && capabilities.length > 0;

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
              No models available on this account
            </span>
          ) : null}
        </div>

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
          <button
            type="button"
            onClick={() => onDisconnect(provider.id)}
            disabled={pending}
            title="Remove the stored credential from the local boundary."
          >
            Disconnect
          </button>
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
 * Settings: unless the credential boundary already reports it connected and
 * capability-bearing, the row states what is required (CLI install, sign-in)
 * and exposes no fake "Connect" button.
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

      <span className="provider-access-row__action" title="Subscription providers are gated until a real runtime adapter exists.">
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
  switch (authState) {
    case "connected":
      return "Connected";
    case "needs-auth":
      return "Needs API key";
    case "install-required":
      return "Install required";
    case "entitlement-pending":
      return "Entitlement pending";
    case "unavailable":
      return "Unavailable";
    case "failed":
      return "Failed";
    default:
      return authState;
  }
}

function QuietPlaceholder({ tab }: { tab: Exclude<SettingsTab, "providers" | "profile" | "appearance" | "workspace"> }) {
  const copy = {
    privacy: {
      description: "Local defaults and data controls will live here."
    },
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

      <article className="profile-clean-card">
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
            <div className="settings-form-grid">
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

          <section className="profile-section" aria-labelledby="profile-security-title">
            <div className="profile-section__heading">
              <span className="settings-panel__icon" aria-hidden="true">
                <LockKey size={19} />
              </span>
              <span>
                <strong id="profile-security-title">Provider credentials</strong>
                <small>API keys are managed in Settings and stored by the local credential boundary.</small>
              </span>
            </div>
            <p className="profile-security-note">
              This local profile is not a hosted Fable account.
            </p>
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
        <h2 id="workspace-heading">Workspace Settings</h2>
        <p>Manage workspace details and collaborative access.</p>
      </div>

      <article className="profile-clean-card">
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
            <div className="settings-form-grid">
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

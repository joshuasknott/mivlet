import {
  CheckCircle,
  GearSix,
  Key,
  LockKey,
  Plugs,
  Spinner,
  Sparkle,
  WarningCircle
} from "@phosphor-icons/react";
import { useRef, useState } from "react";
import type { BackendAuthState, BackendProvider } from "@fable/protocol";
import { providerCapabilityLabels } from "../../lib/backend-capabilities";
import type { ShellRuntime } from "../../hooks/useShellRuntime";

type SettingsTab = "account" | "providers" | "privacy" | "notifications";

const tabs: { id: SettingsTab; label: string }[] = [
  { id: "account", label: "Account" },
  { id: "providers", label: "Providers" },
  { id: "privacy", label: "Privacy" },
  { id: "notifications", label: "Notifications" }
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
export function SettingsPage({ runtime }: { runtime: ShellRuntime }) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("providers");
  const [status, setStatus] = useState("");

  return (
    <section className="settings-single-pane" aria-labelledby="settings-title">
      <div className="settings-single-pane__header">
        <h1 id="settings-title">Settings</h1>
      </div>

      <div className="settings-single-pane__tabs" role="tablist" aria-label="Settings sections">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => {
              setActiveTab(tab.id);
              setStatus(`${tab.label} settings selected.`);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "providers" ? (
        <ProviderAccessView runtime={runtime} onStatus={setStatus} />
      ) : (
        <QuietPlaceholder tab={activeTab} />
      )}

      {status ? (
        <p className="settings-status settings-status--single-pane" role="status">
          {status}
        </p>
      ) : null}
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
    <div className="settings-single-pane__content">
      <div className="settings-section-heading">
        <h2>Provider access</h2>
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
        <Key size={23} />
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
        <Sparkle size={23} />
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
    default:
      return authState;
  }
}

function QuietPlaceholder({ tab }: { tab: Exclude<SettingsTab, "providers"> }) {
  const copy = {
    account: {
      title: "Profile",
      description: "Local profile controls live on the Profile page."
    },
    privacy: {
      title: "Privacy",
      description: "Local defaults and data controls will live here."
    },
    notifications: {
      title: "Notifications",
      description: "Notification preferences will live here."
    }
  };

  return (
    <div className="settings-single-pane__content">
      <div className="settings-section-heading">
        <h2>{copy[tab].title}</h2>
        <p>{copy[tab].description}</p>
      </div>
      <div className="settings-empty-row">
        <GearSix size={18} />
        <span>Nothing to configure yet.</span>
      </div>
    </div>
  );
}

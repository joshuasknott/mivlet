import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  Cpu,
  Key,
  LockSimple,
  Plugs,
  Spinner,
  WarningCircle
} from "@phosphor-icons/react";
import { useState, useEffect, useRef } from "react";
import type { BackendProvider } from "@fable/protocol";
import { providerCapabilityLabels } from "../../lib/backend-capabilities";
import { FableLogo } from "../FableLogo";
import { ProviderIcon } from "../ProviderIcon";

/**
 * Local-first AI-backend onboarding shell.
 *
 * Honesty rules this component:
 *   - No fake account creation or password. The only step before choosing a
 *     backend is an OPTIONAL local profile (name/email), stored as shell state.
 *     Nothing leaves the device; no hosted account is created.
 *   - The API-key path (OpenAI, Anthropic, Gemini, xAI, OpenRouter) is the
 *     primary, runnable path — Fable owns that agent loop once a key is stored.
 *   - Subscription/CLI providers (Codex, Cursor, Copilot, Grok) are listed but
 *     gated as unavailable/setup-required until a real, capability-bearing
 *     runtime is connected. There is no fake "Connect" button that pretends to
 *     link a subscription here; setup routes to the real Connectors/Settings.
 *   - Connector (workspace tools) setup is NOT part of onboarding. It is
 *     optional and lives on the real Connectors page (`onOpenConnectors`).
 *
 * Secrets are never held in React state: the key is read once from an
 * uncontrolled input, handed to the Rust credential boundary via `onConnect`,
 * then cleared from the DOM field.
 */
export function OnboardingPage({
  providers,
  connectedBackendIds,
  status,
  onConnect,
  onSkip,
  onSubmitProfile,
  onOpenConnectors
}: {
  providers: BackendProvider[];
  connectedBackendIds: string[];
  status: string | null;
  /** Connect handler; carries the optional API-key secret for native providers.
   *  The secret is handed to the Rust credential boundary and never read back. */
  onConnect: (providerId: string, secret?: string) => void;
  onSkip: () => void;
  /** Apply the optional local profile (name/email) to shell state. No auth. */
  onSubmitProfile?: (name: string, email: string) => void;
  /** Route to the real Connectors page for optional workspace-tool setup. */
  onOpenConnectors?: () => void;
}) {
  // Steps: an optional local profile, then the backend choice. The connection
  // step is only reachable for the runnable native-API key path.
  const [step, setStep] = useState<"profile" | "choice" | "subscription" | "apikey" | "connection">(
    "profile"
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  // Track the user-selected provider to connect (native-API only).
  const [selectedProvider, setSelectedProvider] = useState<BackendProvider | null>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const [hasSecretKey, setHasSecretKey] = useState(false);

  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);

  // Subscription/CLI providers: gated (no real runtime connected unless the
  // boundary already reports it as capability-bearing). These are shown for
  // awareness, not as a runnable onboarding path.
  const subscriptionProviders = providers.filter(
    (provider) => provider.id === "codex" || provider.id === "cursor" || provider.id === "copilot" || provider.id === "grok"
  );
  // Native API-key providers: the primary, runnable path. Fable owns the loop.
  const nativeProviders = providers.filter((provider) => provider.backendType === "native-api");

  // Reset loading status when a connection completes.
  useEffect(() => {
    if (selectedProvider && connectedBackendIds.includes(selectedProvider.id)) {
      setPendingProviderId(null);
      if (keyInputRef.current) {
        keyInputRef.current.value = "";
      }
      setHasSecretKey(false);
    }
  }, [connectedBackendIds, selectedProvider]);

  const handleSelectProvider = (provider: BackendProvider) => {
    setSelectedProvider(provider);
    if (keyInputRef.current) {
      keyInputRef.current.value = "";
    }
    setHasSecretKey(false);
    setValidationError(null);
    setStep("connection");
  };

  const handleConnect = (provider: BackendProvider, secret?: string) => {
    setPendingProviderId(provider.id);
    onConnect(provider.id, secret);
  };

  const handleProfileSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Local profile only: name is optional, email is validated only if entered.
    // There is no password and no account is created.
    if (email.trim() && !/^\S+@\S+\.\S+$/.test(email)) {
      setValidationError("Enter a valid email, or leave it blank.");
      return;
    }
    setValidationError(null);
    if (onSubmitProfile) {
      onSubmitProfile(name.trim(), email.trim());
    }
    setStep("choice");
  };

  return (
    <main className="og-frame" aria-label="Fable onboarding">
      <div className="og-center">
        {/* Progress Indicator */}
        <div className="og-progress-container">
          <div className="og-progress-bar">
            <div
              className="og-progress-fill"
              style={{
                width:
                  step === "profile"
                    ? "33%"
                    : step === "choice"
                    ? "66%"
                    : step === "apikey" || step === "subscription"
                    ? "80%"
                    : "100%"
              }}
            />
          </div>
          <div className="og-progress-text">
            <span>
              {step === "profile"
                ? "Step 1: Local profile"
                : step === "choice"
                ? "Step 2: Choose backend"
                : step === "apikey" || step === "subscription"
                ? "Step 3: Choose provider"
                : "Step 4: Connection"}
            </span>
            <span>
              {step === "profile" ? "33%" : step === "choice" ? "66%" : step === "connection" ? "100%" : "80%"}
            </span>
          </div>
        </div>

        {step === "profile" && (
          <section className="og-hero" aria-labelledby="onboarding-title">
            <span className="og-greeting" aria-hidden="true">
              <FableLogo className="brand-lockup--onboarding" />
            </span>
            <h1 id="onboarding-title">Set up your local Fable workspace</h1>
            <p className="og-lede">
              Fable runs on this device. No account is created and nothing is sent to a hosted
              service to begin. Add an optional name and email for local display, or skip ahead.
            </p>

            <form className="og-form" onSubmit={handleProfileSubmit}>
              <label className="og-field">
                <span>Name (optional)</span>
                <input
                  type="text"
                  aria-label="Name"
                  id="og-name"
                  placeholder="Josh Knott"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                />
              </label>
              <label className="og-field">
                <span>Email (optional)</span>
                <input
                  type="email"
                  aria-label="Email"
                  id="og-email"
                  placeholder="josh@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                />
              </label>

              {validationError && (
                <p
                  className="og-status"
                  role="alert"
                  style={{ color: "var(--destructive)", margin: "4px 0" }}
                >
                  {validationError}
                </p>
              )}

              <button type="submit" className="og-submit button button--primary">
                Continue
              </button>
            </form>

            <button type="button" className="og-skip button button--ghost" onClick={onSkip}>
              Skip onboarding (preview) <ArrowRight size={14} />
            </button>
          </section>
        )}

        {step === "choice" && (
          <section className="og-hero" aria-labelledby="onboarding-title">
            <span className="og-greeting" aria-hidden="true">
              <FableLogo className="brand-lockup--onboarding" />
            </span>
            <h1 id="onboarding-title">Connect one AI backend to continue</h1>
            <p className="og-lede">
              Bring an API key to run Fable's agent loop directly. Subscription and CLI-backed
              providers are listed but require their real runtime to be set up first.
            </p>

            <div className="og-paths og-paths--3cols">
              <button
                type="button"
                className="og-path og-path--primary"
                onClick={() => setStep("apikey")}
              >
                <div className="og-path__heading">
                  <span className="og-path__icon" aria-hidden="true">
                    <Key size={18} />
                  </span>
                  <span>
                    <strong>Bring an API key</strong>
                    <small>OpenAI, Anthropic, Google, xAI, or OpenRouter</small>
                  </span>
                </div>
                <p className="og-path__note">
                  Direct API integrations. Fable owns the agent loop. Keys are held by your local
                  credential boundary.
                </p>
              </button>

              <button
                type="button"
                className="og-path"
                onClick={() => setStep("subscription")}
              >
                <div className="og-path__heading">
                  <span className="og-path__icon" aria-hidden="true">
                    <Plugs size={18} />
                  </span>
                  <span>
                    <strong>Use a subscription or CLI</strong>
                    <small>Codex, Cursor, GitHub Copilot, or Grok</small>
                  </span>
                </div>
                <p className="og-path__note">
                  Requires the provider's real runtime to be installed and connected. Setup is
                  available, but these are not one-click here.
                </p>
              </button>

              <div className="og-path og-path--disabled" aria-disabled="true">
                <div className="og-path__heading">
                  <span className="og-path__icon" aria-hidden="true">
                    <Cpu size={18} />
                  </span>
                  <span>
                    <strong>Run a local model</strong>
                    <small>Planned — not available yet.</small>
                  </span>
                </div>
                <p className="og-path__note">Local models are on the roadmap but disabled for now.</p>
              </div>
            </div>

            <button type="button" className="og-back-btn button button--ghost" onClick={() => setStep("profile")}>
              <ArrowLeft size={14} /> Back
            </button>
          </section>
        )}

        {step === "subscription" && (
          <section className="og-hero" aria-labelledby="onboarding-title">
            <span className="og-greeting" aria-hidden="true">
              <FableLogo className="brand-lockup--onboarding" />
            </span>
            <h1 id="onboarding-title">Use a subscription or CLI</h1>
            <p className="og-lede">
              These providers require their real runtime to be installed and connected before Fable
              can route through them. None can be "connected" from this screen until that runtime is
              present and capability-bearing.
            </p>

            <div style={{ width: "100%", maxWidth: "600px", marginTop: "24px" }}>
              <ul className="og-provider-list">
                {subscriptionProviders.map((provider) => (
                  <li key={provider.id}>
                    <SubscriptionProviderRow
                      provider={provider}
                      connected={connectedBackendIds.includes(provider.id)}
                      onOpenConnectors={onOpenConnectors}
                    />
                  </li>
                ))}
              </ul>
            </div>

            <button type="button" className="og-back-btn button button--ghost" onClick={() => setStep("choice")}>
              <ArrowLeft size={14} /> Back to options
            </button>
          </section>
        )}

        {step === "apikey" && (
          <section className="og-hero" aria-labelledby="onboarding-title">
            <span className="og-greeting" aria-hidden="true">
              <FableLogo className="brand-lockup--onboarding" />
            </span>
            <h1 id="onboarding-title">Bring an API key</h1>
            <p className="og-lede">
              Select a provider and add its API key. Credentials are held by Fable's local credential
              boundary and never leave this device.
            </p>

            <div style={{ width: "100%", maxWidth: "600px", marginTop: "24px" }}>
              <ul className="og-provider-list">
                {nativeProviders.map((provider) => (
                  <li key={provider.id}>
                    <NativeApiKeyRow
                      provider={provider}
                      connected={connectedBackendIds.includes(provider.id)}
                      onSetUp={() => handleSelectProvider(provider)}
                    />
                  </li>
                ))}
              </ul>
            </div>

            <button type="button" className="og-back-btn button button--ghost" onClick={() => setStep("choice")}>
              <ArrowLeft size={14} /> Back to options
            </button>
          </section>
        )}

        {step === "connection" && selectedProvider && (
          <section className="og-hero" aria-labelledby="onboarding-title">
            <span className="og-greeting" aria-hidden="true">
              <FableLogo className="brand-lockup--onboarding" />
            </span>
            <h1 id="onboarding-title">Connect {selectedProvider.label}</h1>
            <p className="og-lede">{selectedProvider.description}</p>

            {selectedProvider.installHint ? (
              <div className="og-provider__install-banner">
                <WarningCircle size={14} />
                <span>{selectedProvider.installHint}</span>
              </div>
            ) : null}

            <div className="og-connection-box">
              {connectedBackendIds.includes(selectedProvider.id) ? (
                <div className="og-connection-success">
                  <CheckCircle size={48} weight="fill" color="var(--positive)" />
                  <h2>Connected successfully!</h2>
                  <p>Fable is now paired with {selectedProvider.label}.</p>

                  <div className="og-actions-row" style={{ marginTop: "24px" }}>
                    <button
                      type="button"
                      className="og-btn-primary button button--primary"
                      onClick={onSkip}
                    >
                      Start using Fable
                    </button>
                    <button
                      type="button"
                      className="og-btn-secondary button button--secondary"
                      onClick={() => (onOpenConnectors ? onOpenConnectors() : onSkip())}
                    >
                      Set up workspace connectors (optional)
                    </button>
                  </div>
                </div>
              ) : (
                <form
                  className="og-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const secret = keyInputRef.current?.value.trim() ?? "";
                    if (!secret) {
                      setValidationError("Enter an API key to connect.");
                      return;
                    }
                    handleConnect(selectedProvider, secret);
                    if (keyInputRef.current) {
                      keyInputRef.current.value = "";
                    }
                    setHasSecretKey(false);
                  }}
                >
                  {selectedProvider.backendType === "native-api" ? (
                    <label className="og-field">
                      <span>{selectedProvider.label} API Key</span>
                      <input
                        ref={keyInputRef}
                        type="password"
                        aria-label={`API key for ${selectedProvider.label.toLowerCase()}`}
                        placeholder={`Enter your ${selectedProvider.label} API key`}
                        onInput={(e) => setHasSecretKey(Boolean(e.currentTarget.value.trim()))}
                        disabled={pendingProviderId === selectedProvider.id}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </label>
                  ) : null}

                  {validationError && (
                    <p
                      className="og-status"
                      role="alert"
                      style={{ color: "var(--destructive)", margin: "4px 0" }}
                    >
                      {validationError}
                    </p>
                  )}

                  <button
                    type="submit"
                    className="og-submit button button--primary"
                    disabled={
                      (selectedProvider.backendType === "native-api" && !hasSecretKey) ||
                      pendingProviderId === selectedProvider.id
                    }
                  >
                    {pendingProviderId === selectedProvider.id ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                        <Spinner className="og-spinner" size={16} /> Connecting…
                      </span>
                    ) : selectedProvider.backendType === "native-api" ? (
                      "Add key & connect"
                    ) : (
                      "Connect"
                    )}
                  </button>
                </form>
              )}
            </div>

            {status && (
              <p className="og-connection-status-msg" role="status">
                {status}
              </p>
            )}

            {!connectedBackendIds.includes(selectedProvider.id) && (
              <button
                type="button"
                className="og-back-btn button button--ghost"
                onClick={() => {
                  setStep(selectedProvider.backendType === "native-api" ? "apikey" : "subscription");
                  if (keyInputRef.current) {
                    keyInputRef.current.value = "";
                  }
                  setHasSecretKey(false);
                  setValidationError(null);
                }}
              >
                <ArrowLeft size={14} /> Back
              </button>
            )}
          </section>
        )}

        <p className="og-trust" aria-label="Onboarding trust note">
          <LockSimple size={14} />
          Credentials are held by Fable's local credential boundary and never leave this device.
        </p>
      </div>
    </main>
  );
}

/**
 * A subscription/CLI provider row. It is never "one-click connectable" from
 * onboarding: unless the credential boundary already reports it connected and
 * capability-bearing, the action routes the user to real setup (the Connectors
 * page) rather than faking a connection.
 */
function SubscriptionProviderRow({
  provider,
  connected,
  onOpenConnectors
}: {
  provider: BackendProvider;
  connected: boolean;
  onOpenConnectors?: () => void;
}) {
  const capabilityLabels = providerCapabilityLabels(provider);
  // Capability-bearing means the real runtime resolved real capabilities — i.e.
  // it is genuinely connected, not just needs-auth/install-required preview state.
  const capabilityBearing = capabilityLabels.length > 0;
  const installRequired = provider.authState === "install-required";

  return (
    <article
      className={`og-provider${connected ? " og-provider--connected" : ""}`}
      data-provider-id={provider.id}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0 }}>
        <span style={{ display: "grid", placeItems: "center", color: "var(--ink-muted)", flexShrink: 0 }}>
          <ProviderIcon provider={provider.id} size={18} />
        </span>
        <div className="og-provider__lead">
          <strong>{provider.label}</strong>
          <small>{provider.description}</small>
          {installRequired && provider.installHint ? (
            <span className="og-provider__install" aria-label={`${provider.label} install required`}>
              <WarningCircle size={13} /> {provider.installHint}
            </span>
          ) : null}
          {capabilityLabels.length > 0 ? (
            <span className="og-provider__caps">{capabilityLabels.slice(0, 4).join(" · ")}</span>
          ) : null}
        </div>
      </div>
      {connected && capabilityBearing ? (
        <span className="og-provider__connected-badge">
          <CheckCircle size={14} weight="fill" color="var(--positive)" /> Connected
        </span>
      ) : (
        <button
          type="button"
          onClick={() => onOpenConnectors?.()}
          disabled={!onOpenConnectors}
          title="Set up requires the provider's real runtime."
        >
          Set up in Connectors
        </button>
      )}
    </article>
  );
}

function NativeApiKeyRow({
  provider,
  connected,
  onSetUp
}: {
  provider: BackendProvider;
  connected: boolean;
  onSetUp: () => void;
}) {
  const capabilityLabels = providerCapabilityLabels(provider);

  return (
    <article
      className={`og-provider${connected ? " og-provider--connected" : ""}`}
      data-provider-id={provider.id}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0 }}>
        <span style={{ display: "grid", placeItems: "center", color: "var(--ink-muted)", flexShrink: 0 }}>
          <ProviderIcon provider={provider.id} size={18} />
        </span>
        <div className="og-provider__lead">
          <strong>{provider.label}</strong>
          <small>{provider.description}</small>
          {capabilityLabels.length > 0 ? (
            <span className="og-provider__caps">{capabilityLabels.slice(0, 4).join(" · ")}</span>
          ) : null}
        </div>
      </div>
      <button type="button" onClick={onSetUp} disabled={connected}>
        {connected ? "Connected" : "Set up"}
      </button>
    </article>
  );
}

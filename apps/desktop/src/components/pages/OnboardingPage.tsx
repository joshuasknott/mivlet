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
import { useState, useEffect } from "react";
import type { BackendProvider } from "@fable/protocol";
import { providerCapabilityLabels } from "../../lib/backend-capabilities";
import { ConnectorIcon } from "../ConnectorIcon";
import { FableLogo } from "../FableLogo";

/**
 * Three-path AI-backend onboarding shell with Connectors setup.
 */
export function OnboardingPage({
  providers,
  connectedBackendIds,
  status,
  onConnect,
  onSkip,
  onSubmitCredentials
}: {
  providers: BackendProvider[];
  connectedBackendIds: string[];
  status: string | null;
  /** Connect handler; carries the optional API-key secret for native providers.
   *  The secret is handed to the Rust credential boundary and never read back. */
  onConnect: (providerId: string, secret?: string) => void;
  onSkip: () => void;
  onSubmitCredentials?: (name: string, email: string) => void;
}) {
  const [step, setStep] = useState<"credentials" | "choice" | "subscription" | "apikey" | "connection" | "connectors">("credentials");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  // Track the user-selected provider to connect
  const [selectedProvider, setSelectedProvider] = useState<BackendProvider | null>(null);
  const [secretKey, setSecretKey] = useState("");

  // Track mock connector toggles
  const [connectedConnectors, setConnectedConnectors] = useState<string[]>([]);

  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);
  const subscriptionProviders = providers.filter(
    (provider) => provider.id === "codex" || provider.id === "cursor" || provider.id === "copilot" || provider.id === "grok"
  );
  const nativeProviders = providers.filter((provider) => provider.backendType === "native-api");

  // Reset loading status when connection completes
  useEffect(() => {
    if (selectedProvider && connectedBackendIds.includes(selectedProvider.id)) {
      setPendingProviderId(null);
    }
  }, [connectedBackendIds, selectedProvider]);

  const handleSelectProvider = (provider: BackendProvider) => {
    setSelectedProvider(provider);
    setSecretKey("");
    setValidationError(null);
    setStep("connection");
  };

  const handleConnect = (provider: BackendProvider, secret?: string) => {
    setPendingProviderId(provider.id);
    onConnect(provider.id, secret);
  };

  const handleCredentialsSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setValidationError("Name is required");
      return;
    }
    if (!email.trim()) {
      setValidationError("Email is required");
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setValidationError("Invalid email address");
      return;
    }
    if (!password || password.length < 6) {
      setValidationError("Password must be at least 6 characters");
      return;
    }
    setValidationError(null);
    if (onSubmitCredentials) {
      onSubmitCredentials(name, email);
    }
    setStep("choice");
  };

  const toggleConnector = (connectorId: string) => {
    setConnectedConnectors((current) =>
      current.includes(connectorId)
        ? current.filter((id) => id !== connectorId)
        : [...current, connectorId]
    );
  };

  const connectorsList = [
    { id: "github", label: "GitHub" },
    { id: "vercel", label: "Vercel" },
    { id: "google-drive", label: "Google Drive" },
    { id: "notion", label: "Notion" },
    { id: "gmail", label: "Gmail" },
    { id: "slack", label: "Slack" },
    { id: "google-calendar", label: "Google Calendar" },
    { id: "linear", label: "Linear" }
  ];

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
                  step === "credentials"
                    ? "20%"
                    : step === "choice"
                    ? "40%"
                    : step === "subscription" || step === "apikey"
                    ? "60%"
                    : step === "connection"
                    ? "80%"
                    : "100%"
              }}
            />
          </div>
          <div className="og-progress-text">
            <span>
              {step === "credentials"
                ? "Step 1: Account setup"
                : step === "choice"
                ? "Step 2: Choose Backend"
                : step === "subscription" || step === "apikey"
                ? "Step 3: Choose Provider"
                : step === "connection"
                ? "Step 4: Connection"
                : "Step 5: Connectors"}
            </span>
            <span>
              {step === "credentials"
                ? "20%"
                : step === "choice"
                ? "40%"
                : step === "subscription" || step === "apikey"
                ? "60%"
                : step === "connection"
                ? "80%"
                : "100%"}
            </span>
          </div>
        </div>

        {step === "credentials" && (
          <section className="og-hero" aria-labelledby="onboarding-title">
            <span className="og-greeting" aria-hidden="true">
              <FableLogo className="brand-lockup--onboarding" />
            </span>
            <h1 id="onboarding-title">Create your Fable account</h1>
            <p className="og-lede">
              Fable runs agent loops locally and routes consequential actions through approvals. Let's create your account.
            </p>

            <form className="og-form" onSubmit={handleCredentialsSubmit}>
              <label className="og-field">
                <span>Name</span>
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
                <span>Email</span>
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
              <label className="og-field">
                <span>Password</span>
                <input
                  type="password"
                  aria-label="Password"
                  id="og-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
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
              Fable reaches your existing subscriptions through their official runtimes. Choose how you would like to connect.
            </p>

            <div className="og-paths og-paths--3cols">
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
                    <strong>Use a subscription</strong>
                    <small>Codex, Cursor, GitHub Copilot, or Grok</small>
                  </span>
                </div>
                <p className="og-path__note">
                  Use your existing service plans. Connecting any one clears the gate.
                </p>
              </button>

              <button
                type="button"
                className="og-path"
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
                  Direct API integrations. Keys are held by your local credential boundary.
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
                <p className="og-path__note">
                  Local models are on the roadmap but disabled for now.
                </p>
              </div>
            </div>

            <button type="button" className="og-back-btn button button--ghost" onClick={() => setStep("credentials")}>
              <ArrowLeft size={14} /> Back
            </button>
          </section>
        )}

        {step === "subscription" && (
          <section className="og-hero" aria-labelledby="onboarding-title">
            <span className="og-greeting" aria-hidden="true">
              <FableLogo className="brand-lockup--onboarding" />
            </span>
            <h1 id="onboarding-title">Use a subscription</h1>
            <p className="og-lede">
              Select a subscription provider to connect. Codex, Cursor, GitHub Copilot, or Grok are supported.
            </p>

            <div style={{ width: "100%", maxWidth: "600px", marginTop: "24px" }}>
              <ul className="og-provider-list">
                {subscriptionProviders.map((provider) => (
                  <li key={provider.id}>
                    <SubscriptionProviderRow
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

        {step === "apikey" && (
          <section className="og-hero" aria-labelledby="onboarding-title">
            <span className="og-greeting" aria-hidden="true">
              <FableLogo className="brand-lockup--onboarding" />
            </span>
            <h1 id="onboarding-title">Bring an API key</h1>
            <p className="og-lede">
              Select an API key provider to connect. Credentials never leave this device.
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
            <p className="og-lede">
              {selectedProvider.description}
            </p>

            {selectedProvider.installHint && (
              <div className="og-provider__install-banner">
                <WarningCircle size={14} />
                <span>{selectedProvider.installHint}</span>
              </div>
            )}

            <div className="og-connection-box">
              {connectedBackendIds.includes(selectedProvider.id) ? (
                <div className="og-connection-success">
                  <CheckCircle size={48} weight="fill" color="var(--positive)" />
                  <h2>Connected successfully!</h2>
                  <p>Fable is now paired with {selectedProvider.label}.</p>

                  <button
                    type="button"
                    className="og-submit button button--primary"
                    style={{ marginTop: "24px" }}
                    onClick={() => setStep("connectors")}
                  >
                    Continue to connectors
                  </button>
                </div>
              ) : (
                <form
                  className="og-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleConnect(selectedProvider, secretKey);
                  }}
                >
                  {selectedProvider.backendType === "native-api" ? (
                    <label className="og-field">
                      <span>{selectedProvider.label} API Key</span>
                      <input
                        type="password"
                        aria-label={`API key for ${selectedProvider.label.toLowerCase()}`}
                        placeholder={`Enter your ${selectedProvider.label} API key`}
                        value={secretKey}
                        onChange={(e) => setSecretKey(e.target.value)}
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
                      (selectedProvider.backendType === "native-api" && !secretKey.trim()) ||
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
                  setSecretKey("");
                  setValidationError(null);
                }}
              >
                <ArrowLeft size={14} /> Back
              </button>
            )}
          </section>
        )}

        {step === "connectors" && (
          <section className="og-hero" aria-labelledby="onboarding-title">
            <span className="og-greeting" aria-hidden="true">
              <FableLogo className="brand-lockup--onboarding" />
            </span>
            <h1 id="onboarding-title">Connect your workspace tools</h1>
            <p className="og-lede">
              Grant Fable permission to query your documents, code, and calendar contextually.
            </p>

            <div className="og-connectors-grid">
              {connectorsList.map((connector) => {
                const isConnected = connectedConnectors.includes(connector.id);
                return (
                  <button
                    key={connector.id}
                    type="button"
                    className={`og-connector-card${isConnected ? " og-connector-card--connected" : ""}`}
                    onClick={() => toggleConnector(connector.id)}
                    aria-label={`Connect ${connector.label}`}
                  >
                    <span className={`connector-card__logo-container connector-card__logo-container--${connector.id}`}>
                      <ConnectorIcon id={connector.id} />
                    </span>
                    <span className="og-connector-name">{connector.label}</span>
                    <span className="og-connector-status">
                      {isConnected ? "Connected" : "Disconnected"}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="og-actions-row">
              <button type="button" className="og-btn-primary button button--primary" onClick={onSkip}>
                Finish setup
              </button>
              <button type="button" className="og-btn-secondary button button--secondary" onClick={onSkip}>
                Skip for now
              </button>
            </div>
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

function SubscriptionProviderRow({
  provider,
  connected,
  onSetUp
}: {
  provider: BackendProvider;
  connected: boolean;
  onSetUp: () => void;
}) {
  const installRequired = provider.authState === "install-required";
  const capabilityLabels = providerCapabilityLabels(provider);

  return (
    <article
      className={`og-provider${connected ? " og-provider--connected" : ""}`}
      data-provider-id={provider.id}
    >
      <div className="og-provider__lead">
        <strong>{provider.label}</strong>
        <small>{provider.description}</small>
        {installRequired && provider.installHint ? (
          <span className="og-provider__install" aria-label={`${provider.label} install required`}>
            <WarningCircle size={13} /> {provider.installHint}
          </span>
        ) : null}
        {capabilityLabels.length > 0 ? (
          <span className="og-provider__caps">
            {capabilityLabels.slice(0, 4).join(" · ")}
          </span>
        ) : null}
      </div>
      <button type="button" onClick={onSetUp} disabled={connected}>
        {connected ? "Connected" : "Set up"}
      </button>
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
      <div className="og-provider__lead">
        <strong>{provider.label}</strong>
        <small>{provider.description}</small>
        {capabilityLabels.length > 0 ? (
          <span className="og-provider__caps">
            {capabilityLabels.slice(0, 4).join(" · ")}
          </span>
        ) : null}
      </div>
      <button type="button" onClick={onSetUp} disabled={connected}>
        {connected ? "Connected" : "Set up"}
      </button>
    </article>
  );
}

import {
  ArrowRight,
  Cpu,
  Key,
  LockSimple,
  Plugs,
  Sparkle,
  WarningCircle
} from "@phosphor-icons/react";
import { useState } from "react";
import type { BackendProvider } from "@arden/protocol";
import { providerCapabilityLabels } from "../../lib/backend-capabilities";

/**
 * Three-path AI-backend onboarding shell.
 *
 *   1. Subscription (functional): Codex, Cursor, Copilot, Grok — connecting any
 *      one clears the gate.
 *   2. API key (pending): shown but disabled — native API keys land in the next
 *      goal; only the foundation ships here.
 *   3. Local model (disabled-but-present): planned, surfaced so the path is
 *      visible even though it is not actionable yet.
 *
 * The gate copy is "Connect one AI backend to continue." A "Skip for now"
 * link reaches the preview workspace for testing outside Tauri.
 *
 * Only the subscription path is interactive because adapters must not fake
 * capabilities they lack — the API-key and local paths fail closed here.
 */
export function OnboardingPage({
  providers,
  connectedBackendIds,
  status,
  onConnect,
  onSkip
}: {
  providers: BackendProvider[];
  connectedBackendIds: string[];
  status: string | null;
  /** Connect handler; carries the optional API-key secret for native providers.
   *  The secret is handed to the Rust credential boundary and never read back. */
  onConnect: (providerId: string, secret?: string) => void;
  onSkip: () => void;
}) {
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);
  const subscriptionProviders = providers.filter(
    (provider) => provider.id === "codex" || provider.id === "cursor" || provider.id === "copilot" || provider.id === "grok"
  );
  const nativeProviders = providers.filter((provider) => provider.backendType === "native-api");

  const handleConnect = (provider: BackendProvider, secret?: string) => {
    setPendingProviderId(provider.id);
    onConnect(provider.id, secret);
  };

  return (
    <main className="onboarding-frame" aria-label="Arden onboarding">
      <section className="onboarding-panel" aria-labelledby="onboarding-title">
        <span className="onboarding-mark" aria-hidden="true">
          <Sparkle size={26} weight="regular" />
        </span>
        <h1 id="onboarding-title">Connect one AI backend to continue</h1>
        <p className="onboarding-lede">
          Arden reaches your existing subscriptions through their official runtimes and routes
          every consequential action through its own approval system. Pick a backend to start.
        </p>

        <div className="onboarding-paths">
          <div className="onboarding-path onboarding-path--primary">
            <div className="onboarding-path__heading">
              <span className="onboarding-path__icon" aria-hidden="true">
                <Plugs size={18} />
              </span>
              <span>
                <strong>Use a subscription</strong>
                <small>Codex, Cursor, GitHub Copilot, or Grok</small>
              </span>
            </div>
            <ul className="onboarding-provider-list">
              {subscriptionProviders.map((provider) => (
                <li key={provider.id}>
                  <SubscriptionProviderRow
                    provider={provider}
                    connected={connectedBackendIds.includes(provider.id)}
                    pending={pendingProviderId === provider.id}
                    onConnect={() => handleConnect(provider)}
                  />
                </li>
              ))}
            </ul>
          </div>

          <div className="onboarding-path onboarding-path--apikey">
            <div className="onboarding-path__heading">
              <span className="onboarding-path__icon" aria-hidden="true">
                <Key size={18} />
              </span>
              <span>
                <strong>Bring an API key</strong>
                <small>OpenAI, Anthropic, Google, xAI, or OpenRouter</small>
              </span>
            </div>
            <p className="onboarding-path__note">
              Arden owns the agent loop directly. Claude is reached via an Anthropic API key,
              Vertex, or Bedrock; Gemini via a Google AI API key or Vertex. Keys are held by the
              local credential boundary.
            </p>
            <ul className="onboarding-provider-list">
              {nativeProviders.map((provider) => (
                <li key={provider.id}>
                  <NativeApiKeyRow
                    provider={provider}
                    connected={connectedBackendIds.includes(provider.id)}
                    pending={pendingProviderId === provider.id}
                    onConnect={(secret) => handleConnect(provider, secret)}
                  />
                </li>
              ))}
            </ul>
          </div>

          <div className="onboarding-path onboarding-path--disabled" aria-disabled="true">
            <div className="onboarding-path__heading">
              <span className="onboarding-path__icon" aria-hidden="true">
                <Cpu size={18} />
              </span>
              <span>
                <strong>Run a local model</strong>
                <small>Planned — not available yet.</small>
              </span>
            </div>
            <p className="onboarding-path__note">
              Local models are on the roadmap but disabled for now.
            </p>
          </div>
        </div>

        <p className="onboarding-trust" aria-label="Onboarding trust note">
          <LockSimple size={14} />
          Credentials are held by Arden's local credential boundary and never leave this device in
          this release.
        </p>

        {status ? (
          <p className="onboarding-status" role="status">
            {status}
          </p>
        ) : null}

        <button type="button" className="onboarding-skip" onClick={onSkip}>
          Skip for now (preview) <ArrowRight size={14} />
        </button>
      </section>
    </main>
  );
}

function SubscriptionProviderRow({
  provider,
  connected,
  pending,
  onConnect
}: {
  provider: BackendProvider;
  connected: boolean;
  pending: boolean;
  onConnect: () => void;
}) {
  const installRequired = provider.authState === "install-required";
  const capabilityLabels = providerCapabilityLabels(provider);
  const disabled = pending || connected;

  return (
    <article
      className={`onboarding-provider${connected ? " onboarding-provider--connected" : ""}`}
      data-provider-id={provider.id}
    >
      <div className="onboarding-provider__lead">
        <strong>{provider.label}</strong>
        <small>{provider.description}</small>
        {installRequired && provider.installHint ? (
          <span className="onboarding-provider__install" aria-label={`${provider.label} install required`}>
            <WarningCircle size={13} /> {provider.installHint}
          </span>
        ) : null}
        {capabilityLabels.length > 0 ? (
          <span className="onboarding-provider__caps">
            {capabilityLabels.slice(0, 4).join(" · ")}
          </span>
        ) : null}
      </div>
      <button type="button" onClick={onConnect} disabled={disabled}>
        {connected ? "Connected" : pending ? "Connecting…" : "Connect"}
      </button>
    </article>
  );
}

/**
 * A native-API provider row with a secret input. The secret is handed to the
 * Rust credential boundary on connect and never read back into React state
 * beyond the controlled input's transient value.
 */
function NativeApiKeyRow({
  provider,
  connected,
  pending,
  onConnect
}: {
  provider: BackendProvider;
  connected: boolean;
  pending: boolean;
  onConnect: (secret: string) => void;
}) {
  const [secret, setSecret] = useState("");
  const capabilityLabels = providerCapabilityLabels(provider);
  const disabled = pending || connected;
  const canConnect = secret.trim().length > 0 && !disabled;

  return (
    <article
      className={`onboarding-provider${connected ? " onboarding-provider--connected" : ""}`}
      data-provider-id={provider.id}
    >
      <div className="onboarding-provider__lead">
        <strong>{provider.label}</strong>
        <small>{provider.description}</small>
        {capabilityLabels.length > 0 ? (
          <span className="onboarding-provider__caps">
            {capabilityLabels.slice(0, 4).join(" · ")}
          </span>
        ) : null}
      </div>
      <div className="onboarding-provider__apikey">
        <input
          type="password"
          aria-label={`API key for ${provider.label}`}
          placeholder={`${provider.label} API key`}
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => onConnect(secret)}
          disabled={!canConnect}
        >
          {connected ? "Connected" : pending ? "Connecting…" : "Add key"}
        </button>
      </div>
    </article>
  );
}

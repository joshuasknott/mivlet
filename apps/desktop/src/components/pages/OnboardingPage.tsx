import {
  ArrowRight,
  CheckCircle,
  Key,
  Spinner,
  WarningCircle,
  X
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { BackendProvider, BackendVerifyResult } from "@fable/protocol";
import {
  authKindForProvider,
  stateClassFor,
  stateViewFor
} from "../../lib/backend-state";
import { providerCapabilityLabels } from "../../lib/backend-capabilities";
import { ProviderIcon } from "../ProviderIcon";

/**
 * Local-first AI-backend onboarding — rebuilt as ONE unified provider list.
 *
 * Honesty rules this component:
 *   - No fake account creation. The only step before choosing a backend is a
 *     local profile. Name/email are stored as shell state; the password field
 *     is intentionally UI-only and is neither read nor persisted.
 *   - Every provider appears in a single list with its real auth-state badge
 *     and exactly one context-correct action. There is no fake "Connect".
 *   - API-key providers (OpenAI, Anthropic, Gemini, xAI, OpenRouter) expand an
 *     inline secure key field. The key is read once from an uncontrolled
 *     input, handed to the verified connect path, then cleared from the DOM.
 *   - Provider-owned runtimes (Codex CLI, Cursor/Grok ACP, Copilot SDK) manage
 *     their OWN sign-in. They NEVER show a token field here. Their cards
 *     reflect the runtime state the boundary resolved and route to real setup.
 *   - Connector (workspace tools) setup is NOT part of onboarding. It is
 *     optional and lives on the real Connectors page (`onOpenConnectors`).
 *
 * Secrets are never held in React state: the key is read once from an
 * uncontrolled input, handed to the Rust credential boundary via
 * `onConnectWithVerify`, then cleared from the DOM field. Only the verify
 * OUTCOME (ready / auth-failed / offline / unsupported / failed) returns.
 */
export function OnboardingPage({
  providers,
  connectedBackendIds,
  status,
  onConnect,
  onConnectWithVerify,
  onSkip,
  onSubmitProfile,
  onOpenConnectors
}: {
  providers: BackendProvider[];
  connectedBackendIds: string[];
  status: string | null;
  /** Legacy fire-and-forget connect. Kept for back-compat; the verified path
   *  is preferred and used when `onConnectWithVerify` is supplied. */
  onConnect?: (providerId: string, secret?: string) => void;
  /** Verified connect path: stores the key, verifies it inside the Rust
   *  boundary, and returns the outcome so useful errors can be shown. The
   *  secret is handed to the boundary and never read back. */
  onConnectWithVerify?: (
    providerId: string,
    secret: string
  ) => Promise<BackendVerifyResult>;
  onSkip: () => void;
  /** Apply the local profile (name/email) to shell state. No auth. */
  onSubmitProfile?: (name: string, email: string) => void;
  /** Route to the real Connectors page for optional workspace-tool setup. */
  onOpenConnectors?: () => void;
}) {
  // Steps: a local profile, then the unified provider list.
  const [step, setStep] = useState<"profile" | "providers">(providers.length === 0 ? "providers" : "profile");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  // The provider currently being verified, and the per-provider error message.
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);
  const [providerError, setProviderError] = useState<Record<string, string>>({});

  const keyInputRef = useRef<HTMLInputElement>(null);

  const hasAnyConnected = connectedBackendIds.length > 0;

  const handleProfileSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // The password input is deliberately not read or submitted; no account is created.
    if (email.trim() && !/^\S+@\S+\.\S+$/.test(email)) {
      setValidationError("Enter a valid email, or leave it blank.");
      return;
    }
    setValidationError(null);
    if (onSubmitProfile) {
      onSubmitProfile(name.trim(), email.trim());
    }
    setStep("providers");
  };

  // Clear any stale key/error when a provider finishes connecting.
  useEffect(() => {
    for (const id of connectedBackendIds) {
      if (providerError[id]) {
        setProviderError((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
      }
    }
    if (pendingProviderId && connectedBackendIds.includes(pendingProviderId)) {
      setPendingProviderId(null);
      setSelectedProviderId(null);
      if (keyInputRef.current) {
        keyInputRef.current.value = "";
      }
    }
  }, [connectedBackendIds, pendingProviderId, providerError]);

  const handleToggleProvider = (provider: BackendProvider) => {
    if (pendingProviderId) return;
    setSelectedProviderId(provider.id);
    setProviderError((current) => {
      const next = { ...current };
      delete next[provider.id];
      return next;
    });
    // Clear any value left in the shared uncontrolled input.
    if (keyInputRef.current) {
      keyInputRef.current.value = "";
    }
  };
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);

  const handleConnect = async (provider: BackendProvider) => {
    const secret = keyInputRef.current?.value.trim() ?? "";
    if (!secret) {
      setProviderError((current) => ({
        ...current,
        [provider.id]: "Enter an API key to connect."
      }));
      return;
    }
    setPendingProviderId(provider.id);
    setProviderError((current) => {
      const next = { ...current };
      delete next[provider.id];
      return next;
    });
    try {
      const result = onConnectWithVerify
        ? await onConnectWithVerify(provider.id, secret)
        : (onConnect?.(provider.id, secret),
          ({ providerId: provider.id, outcome: "ready" } as BackendVerifyResult));
      // Clear the uncontrolled input immediately — the secret is now in the
      // boundary and must not linger in the DOM.
      if (keyInputRef.current) {
        keyInputRef.current.value = "";
      }
      if (result.outcome === "auth-failed") {
        setProviderError((current) => ({
          ...current,
          [provider.id]:
            result.message ?? `${provider.label} rejected this key. Check the key and try again.`
        }));
      } else if (result.outcome !== "ready") {
        // offline / unsupported / failed: keep the key stored, show a warning.
        setProviderError((current) => ({
          ...current,
          [provider.id]:
            result.message ??
            `${provider.label} could not be verified right now. Your key is saved — try again in a moment.`
        }));
      }
    } catch (error) {
      if (keyInputRef.current) {
        keyInputRef.current.value = "";
      }
      setProviderError((current) => ({
        ...current,
        [provider.id]: error instanceof Error ? error.message : `Could not connect ${provider.label}.`
      }));
    } finally {
      setPendingProviderId(null);
    }
  };

  return (
    <main className="og-frame" aria-label="Fable onboarding">
      <div className="og-center">
        <nav className="og-progress-container" aria-label="Onboarding progress">
          <ol className="og-progress-steps">
            <li
              className={step === "profile" ? "og-progress-step is-current" : "og-progress-step is-complete"}
              aria-current={step === "profile" ? "step" : undefined}
            >
              <span aria-hidden="true">{step === "providers" ? <CheckCircle size={14} weight="fill" /> : "1"}</span>
              Local profile
            </li>
            <li
              className={step === "providers" ? "og-progress-step is-current" : "og-progress-step"}
              aria-current={step === "providers" ? "step" : undefined}
            >
              <span aria-hidden="true">2</span>
              Model provider
            </li>
          </ol>
          <p className="og-progress-status" role="status">
            Step {step === "profile" ? "1" : "2"} of 2
          </p>
        </nav>

        {step === "profile" && (
          <section className="og-hero" aria-labelledby="onboarding-title">
            <h1 id="onboarding-title">Set up your local Fable workspace</h1>
            <p className="og-lede">
              Fable runs on this device. No account is created and nothing is sent to a hosted
              service to begin. Add your local profile details, then choose a model provider.
            </p>

            <form className="og-form" onSubmit={handleProfileSubmit}>
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
                  placeholder="Enter a password"
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

            <button type="button" className="og-skip button button--ghost" onClick={onSkip} style={{ marginTop: 6 }}>
              Skip onboarding (preview) <ArrowRight size={14} />
            </button>
          </section>
        )}

        {step === "providers" && (
          <section className="og-hero" aria-labelledby="onboarding-title">
            <h1 id="onboarding-title">Add a model provider</h1>
            <p className="og-lede">
              Add one provider to start. Bring an API key for OpenAI, Anthropic, Gemini, xAI, or
              OpenRouter — or use Codex, Cursor, Copilot, or Grok through their own sign-in.
            </p>

            <div className="og-unified">
              <p className="og-unified__hint">
                Choose a provider. You can add or change providers later in Settings.
              </p>

              <ul className="og-provider-list">
                {providers.map((provider) => (
                  <li key={provider.id}>
                    <ProviderRow
                      provider={provider}
                      connected={connectedBackendIds.includes(provider.id)}
                      expanded={false}
                      pending={pendingProviderId === provider.id}
                      error={providerError[provider.id]}
                      keyInputRef={keyInputRef}
                      onToggle={() => handleToggleProvider(provider)}
                      onConnect={() => void handleConnect(provider)}
                      onOpenConnectors={onOpenConnectors}
                    />
                  </li>
                ))}
              </ul>

              {selectedProvider ? (
                <OnboardingProviderModal
                  provider={selectedProvider}
                  connected={connectedBackendIds.includes(selectedProvider.id)}
                  pending={pendingProviderId === selectedProvider.id}
                  error={providerError[selectedProvider.id]}
                  keyInputRef={keyInputRef}
                  onClose={() => setSelectedProviderId(null)}
                  onConnect={() => void handleConnect(selectedProvider)}
                  onOpenConnectors={onOpenConnectors}
                />
              ) : null}
            </div>

            {status ? (
              <p className="og-connection-status-msg" role="status">
                {status}
              </p>
            ) : null}

            {hasAnyConnected ? (
              <div className="og-primary-cta">
                <button
                  type="button"
                  className="og-primary-cta__start"
                  onClick={onSkip}
                >
                  Start using Fable
                </button>
                {onOpenConnectors ? (
                  <button
                    type="button"
                    className="og-primary-cta__secondary"
                    onClick={onOpenConnectors}
                  >
                    Set up workspace connectors (optional)
                  </button>
                ) : null}
              </div>
            ) : (
              <button type="button" className="og-skip button button--ghost" onClick={onSkip}>
                Skip onboarding (preview) <ArrowRight size={14} />
              </button>
            )}
          </section>
        )}

      </div>
    </main>
  );
}

/**
 * One provider row in the unified list. Renders the real auth-state badge and
 * exactly one context-correct action. API-key providers expand an inline secure
 * key field; provider-owned runtimes never show a key field.
 */
function ProviderRow({
  provider,
  connected,
  expanded,
  pending,
  error,
  keyInputRef,
  onToggle,
  onConnect,
  onOpenConnectors
}: {
  provider: BackendProvider;
  connected: boolean;
  expanded: boolean;
  pending: boolean;
  error?: string;
  keyInputRef: React.RefObject<HTMLInputElement | null>;
  onToggle: () => void;
  onConnect: () => void;
  onOpenConnectors?: () => void;
}) {
  const kind = authKindForProvider(provider);
  const view = stateViewFor(provider.authState);
  const capabilityLabels = providerCapabilityLabels(provider);
  const isApiKey = kind === "api-key";
  // The key panel is only for API-key providers, and only meaningful when the
  // provider is not already connected.
  const canExpandKey = isApiKey && !connected;

  const kindLabel = isApiKey ? "API key" : "Provider sign-in";

  const renderAction = () => {
    if (connected) {
      return (
        <span className="og-provider__badge og-provider__badge--ready">
          <CheckCircle size={13} weight="fill" /> Connected
        </span>
      );
    }
    if (provider.authState === "connecting" || pending) {
      return (
        <span className="og-provider__badge og-provider__badge--info">
          <Spinner className="og-spinner" size={13} /> Connecting
        </span>
      );
    }
    if (isApiKey) {
      return (
        <span className="og-provider__action-label">Add API key</span>
      );
    }
    // Provider-owned runtime: route to real setup, never a fake connect.
    return (
      <span className="og-provider__action-label" aria-disabled={!onOpenConnectors}>
        Set up
      </span>
    );
  };

  return (
    <article
      className={`og-provider${canExpandKey ? " og-provider--expandable" : ""}${expanded ? " og-provider--selected" : ""} ${stateClassFor(provider.authState)}`}
      data-provider-id={provider.id}
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggle();
        }
      }}
    >
      <div className="og-provider__row">
        <div className="og-provider__identity">
          <span className="og-provider__icon">
            <ProviderIcon provider={provider.id} size={24} />
          </span>
          <div className="og-provider__lead">
            <strong>{provider.label}</strong>
            <span className="og-provider__kind" aria-label={`${provider.label} ${kindLabel}`}>
              {kindLabel}
            </span>
          </div>
        </div>
        <div className="og-provider__action">
          {/* Show the state badge only for non-default states, to keep the UI
              plain. needs-auth is the default for unconnected API-key rows. The
              accessible state label lives on the state-hint below (which carries
              the provider-specific copy), so the badge stays decorative. */}
          {provider.authState !== "needs-auth" && !connected ? (
            <span
              className={`og-provider__badge og-provider__badge--${view.tone}`}
              aria-hidden="true"
            >
              {view.tone === "danger" || view.tone === "caution" ? (
                <WarningCircle size={13} />
              ) : null}
              {view.label}
            </span>
          ) : null}
          {renderAction()}
        </div>
      </div>

      {expanded ? (
        <p className="og-provider__description">
          {provider.description}
          {capabilityLabels.length > 0 ? ` · ${capabilityLabels.slice(0, 4).join(" · ")}` : ""}
        </p>
      ) : null}

      {/* State hint for non-ready states (plain explanation). For install-
          required providers, the specific install hint (e.g. "Requires the
          Cursor CLI") is more useful than the generic copy. */}
      {!connected && provider.authState !== "needs-auth" ? (
        <p
          className={`og-provider__state-hint${
            view.tone === "danger" ? " og-provider__state-hint--danger" : ""
          }${view.tone === "caution" ? " og-provider__state-hint--caution" : ""}`}
          data-visually-hidden={provider.authState === "install-required" ? "true" : undefined}
          aria-label={
            provider.authState === "install-required"
              ? `${provider.label} install required`
              : undefined
          }
        >
          {provider.authState === "install-required" && provider.installHint
            ? provider.installHint
            : view.hint}
        </p>
      ) : null}

      {/* Inline error from a failed verification (kept visible until retry). */}
      {error ? (
        <p className="og-provider__state-hint og-provider__state-hint--danger" role="alert">
          {error}
        </p>
      ) : null}

      {/* Expandable secure key panel — API-key providers only. */}
      {canExpandKey && expanded ? (
        <div className="og-provider__key-panel" id={`og-key-panel-${provider.id}`}>
          <label>
            <span>{provider.label} API key</span>
            <input
              ref={keyInputRef}
              type="password"
              aria-label={`API key for ${provider.label.toLowerCase()}`}
              placeholder={`Enter your ${provider.label} API key`}
              disabled={pending}
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void onConnect();
                }
              }}
            />
          </label>
          <div className="og-provider__key-actions">
            <button
              type="button"
              onClick={onConnect}
              disabled={pending}
            >
              {pending ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                  <Spinner className="og-spinner" size={14} /> Verifying…
                </span>
              ) : (
                "Add key & connect"
              )}
            </button>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                color: "var(--ink-soft)",
                fontSize: "var(--text-11)"
              }}
            >
              <Key size={12} /> Stored in your device's secure storage
            </span>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function OnboardingProviderModal({
  provider,
  connected,
  pending,
  error,
  keyInputRef,
  onClose,
  onConnect,
  onOpenConnectors
}: {
  provider: BackendProvider;
  connected: boolean;
  pending: boolean;
  error?: string;
  keyInputRef: React.RefObject<HTMLInputElement | null>;
  onClose: () => void;
  onConnect: () => void;
  onOpenConnectors?: () => void;
}) {
  const kind = authKindForProvider(provider);
  const view = stateViewFor(provider.authState);
  const capabilityLabels = providerCapabilityLabels(provider);
  const isApiKey = kind === "api-key";

  return (
    <div className="og-provider-modal" role="dialog" aria-modal="true" aria-labelledby={`og-provider-modal-${provider.id}`}>
      <article className="og-provider-modal__panel">
        <header className="og-provider-modal__header">
          <span className="og-provider__icon" aria-hidden="true">
            <ProviderIcon provider={provider.id} size={28} />
          </span>
          <div>
            <h2 id={`og-provider-modal-${provider.id}`}>{provider.label}</h2>
            <p>{provider.description}</p>
          </div>
          <button type="button" className="og-provider-modal__close" aria-label="Close provider setup" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div className="og-provider-modal__body">
          <span className={`og-provider__badge og-provider__badge--${connected ? "ready" : view.tone}`}>
            {connected ? <CheckCircle size={13} weight="fill" /> : null}
            {connected ? "Connected" : view.label}
          </span>
          <p className="og-provider__description">
            {capabilityLabels.length > 0
              ? capabilityLabels.slice(0, 4).join(" / ")
              : isApiKey
                ? "Add a key stored on this device."
                : "Set up the provider's own runtime or sign-in first."}
          </p>

          {error ? (
            <p className="og-provider__state-hint og-provider__state-hint--danger" role="alert">
              {error}
            </p>
          ) : null}

          {isApiKey && !connected ? (
            <div className="og-provider__key-panel">
              <label>
                <span>{provider.label} API key</span>
                <input
                  ref={keyInputRef}
                  type="password"
                  aria-label={`API key for ${provider.label.toLowerCase()}`}
                  placeholder={`Enter your ${provider.label} API key`}
                  disabled={pending}
                  autoComplete="off"
                  spellCheck={false}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void onConnect();
                    }
                  }}
                />
              </label>
              <div className="og-provider__key-actions">
                <button type="button" onClick={onConnect} disabled={pending}>
                  {pending ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                      <Spinner className="og-spinner" size={14} /> Verifying...
                    </span>
                  ) : (
                    "Add key & connect"
                  )}
                </button>
                <span>
                  <Key size={12} /> Stored on this device
                </span>
              </div>
            </div>
          ) : null}

          {!isApiKey && !connected ? (
            <button
              type="button"
              className="og-provider-modal__primary"
              onClick={() => onOpenConnectors?.()}
              disabled={!onOpenConnectors}
            >
              Open setup
            </button>
          ) : null}
        </div>
      </article>
    </div>
  );
}

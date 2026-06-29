import {
  ArrowRight,
  CheckCircle,
  Key,
  LockSimple,
  Plugs,
  Spinner,
  WarningCircle
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { BackendProvider, BackendVerifyResult } from "@fable/protocol";
import {
  authKindForProvider,
  stateClassFor,
  stateViewFor
} from "../../lib/backend-state";
import { providerCapabilityLabels } from "../../lib/backend-capabilities";
import { FableLogo } from "../FableLogo";
import { ProviderIcon } from "../ProviderIcon";

/**
 * Local-first AI-backend onboarding — rebuilt as ONE unified provider list.
 *
 * Honesty rules this component:
 *   - No fake account creation or password. The only step before choosing a
 *     backend is an OPTIONAL local profile (name/email), stored as shell state.
 *     Nothing leaves the device; no hosted account is created.
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
  /** Apply the optional local profile (name/email) to shell state. No auth. */
  onSubmitProfile?: (name: string, email: string) => void;
  /** Route to the real Connectors page for optional workspace-tool setup. */
  onOpenConnectors?: () => void;
}) {
  // Steps: an optional local profile, then the unified provider list.
  const [step, setStep] = useState<"profile" | "providers">(providers.length === 0 ? "providers" : "profile");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  // Track the provider whose inline key panel is expanded (API-key only).
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);
  // The provider currently being verified, and the per-provider error message.
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);
  const [providerError, setProviderError] = useState<Record<string, string>>({});

  const keyInputRef = useRef<HTMLInputElement>(null);

  const hasAnyConnected = connectedBackendIds.length > 0;

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
      setExpandedProviderId(null);
      if (keyInputRef.current) {
        keyInputRef.current.value = "";
      }
    }
  }, [connectedBackendIds, pendingProviderId, providerError]);

  const handleToggleProvider = (provider: BackendProvider) => {
    if (pendingProviderId) return;
    if (expandedProviderId === provider.id) {
      setExpandedProviderId(null);
      return;
    }
    setExpandedProviderId(provider.id);
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
        {/* Progress Indicator */}
        <div className="og-progress-container">
          <div className="og-progress-bar">
            <div
              className="og-progress-fill"
              style={{ width: step === "profile" ? "40%" : "100%" }}
            />
          </div>
          <div className="og-progress-text">
            <span>{step === "profile" ? "Step 1: Local profile" : "Step 2: Add a provider"}</span>
            <span>{step === "profile" ? "40%" : "100%"}</span>
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
                  aria-label="Name (optional)"
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
                  aria-label="Email (optional)"
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

            <button type="button" className="og-skip button button--ghost" onClick={() => setStep("providers")}>
              Continue without profile <ArrowRight size={14} />
            </button>
            <button type="button" className="og-skip button button--ghost" onClick={onSkip} style={{ marginTop: 6 }}>
              Skip onboarding (preview) <ArrowRight size={14} />
            </button>
          </section>
        )}

        {step === "providers" && (
          <section className="og-hero" aria-labelledby="onboarding-title">
            <span className="og-greeting" aria-hidden="true">
              <FableLogo className="brand-lockup--onboarding" />
            </span>
            <h1 id="onboarding-title">Add a model provider</h1>
            <p className="og-lede">
              Add one provider to start. Bring an API key for OpenAI, Anthropic, Gemini, xAI, or
              OpenRouter — or use Codex, Cursor, Copilot, or Grok through their own sign-in.
            </p>

            <div className="og-unified">
              <p className="og-unified__hint">
                Keys live in your device's secure storage and never leave it. Provider-owned
                runtimes (Codex, Cursor, Copilot, Grok) manage their own sign-in.
              </p>

              <ul className="og-provider-list">
                {providers.map((provider) => (
                  <li key={provider.id}>
                    <ProviderRow
                      provider={provider}
                      connected={connectedBackendIds.includes(provider.id)}
                      expanded={expandedProviderId === provider.id}
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

        <p className="og-trust" aria-label="Onboarding trust note">
          <LockSimple size={14} />
          Credentials are held by Fable's local credential boundary and never leave this device.
        </p>
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
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={`og-key-panel-${provider.id}`}
        >
          {expanded ? "Cancel" : "Add API key"}
        </button>
      );
    }
    // Provider-owned runtime: route to real setup, never a fake connect.
    return (
      <button
        type="button"
        onClick={() => onOpenConnectors?.()}
        disabled={!onOpenConnectors}
        title="Set up requires the provider's real runtime."
      >
        Set up
      </button>
    );
  };

  return (
    <article
      className={`og-provider${canExpandKey ? " og-provider--expandable" : ""} ${stateClassFor(provider.authState)}`}
      data-provider-id={provider.id}
    >
      <div className="og-provider__row">
        <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0 }}>
          <span
            style={{
              display: "grid",
              placeItems: "center",
              color: "var(--ink-muted)",
              flexShrink: 0
            }}
          >
            <ProviderIcon provider={provider.id} size={18} />
          </span>
          <div className="og-provider__lead">
            <strong>{provider.label}</strong>
            <small>{provider.description}</small>
            <span className="og-provider__kind" aria-label={`${provider.label} ${kindLabel}`}>
              {kindLabel}
            </span>
            {capabilityLabels.length > 0 ? (
              <span className="og-provider__caps">{capabilityLabels.slice(0, 4).join(" · ")}</span>
            ) : null}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexShrink: 0 }}>
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

      {/* State hint for non-ready states (plain explanation). For install-
          required providers, the specific install hint (e.g. "Requires the
          Cursor CLI") is more useful than the generic copy. */}
      {!connected && provider.authState !== "needs-auth" ? (
        <p
          className={`og-provider__state-hint${
            view.tone === "danger" ? " og-provider__state-hint--danger" : ""
          }${view.tone === "caution" ? " og-provider__state-hint--caution" : ""}`}
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

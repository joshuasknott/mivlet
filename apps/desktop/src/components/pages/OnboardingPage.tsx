import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { useState } from "react";
import type { BackendProvider, BackendVerifyResult } from "@fable/protocol";
import { ProviderCatalogue } from "../providers/ProviderCatalogue";

/**
 * Local-first onboarding. Provider selection uses the same provider-family
 * catalogue and connection-method modal as Settings, so subscription, OAuth,
 * API-key, CLI, and local access never drift into separate product flows.
 */
export function OnboardingPage({
  providers,
  connectedBackendIds,
  status,
  onConnect,
  onConnectWithVerify,
  onCheckConnection,
  onSkip,
  onSubmitProfile
}: {
  providers: BackendProvider[];
  connectedBackendIds: string[];
  status: string | null;
  /** Legacy fire-and-forget connect used only when verification is unavailable. */
  onConnect?: (providerId: string, secret?: string) => void;
  /** Credentials cross directly into the verified Rust boundary. */
  onConnectWithVerify?: (
    providerId: string,
    secret: string
  ) => Promise<BackendVerifyResult>;
  /** Re-probe a provider-owned CLI after the user completes its login flow. */
  onCheckConnection?: (providerId: string) => void | Promise<void>;
  onSkip: () => void;
  onSubmitProfile?: (name: string, email: string) => void;
  /** Retained for App compatibility; provider setup no longer routes to connectors. */
  onOpenConnectors?: () => void;
}) {
  const [step, setStep] = useState<"profile" | "providers">(
    providers.length === 0 ? "providers" : "profile"
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const hasAnyConnected = connectedBackendIds.length > 0;

  const handleProfileSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (email.trim() && !/^\S+@\S+\.\S+$/.test(email)) {
      setValidationError("Enter a valid email, or leave it blank.");
      return;
    }
    setValidationError(null);
    onSubmitProfile?.(name.trim(), email.trim());
    setStep("providers");
  };

  const handleConnect = async (
    providerId: string,
    secret: string
  ): Promise<BackendVerifyResult> => {
    if (onConnectWithVerify) return onConnectWithVerify(providerId, secret);
    onConnect?.(providerId, secret);
    return { providerId, outcome: "ready" };
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
              <span aria-hidden="true">
                {step === "providers" ? <CheckCircle size={14} weight="fill" /> : "1"}
              </span>
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

        {step === "profile" ? (
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
                  onChange={(event) => setName(event.target.value)}
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
                  onChange={(event) => setEmail(event.target.value)}
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

              {validationError ? (
                <p className="og-status og-status--error" role="alert">
                  {validationError}
                </p>
              ) : null}

              <button type="submit" className="og-submit button button--primary">
                Continue
              </button>
            </form>

            <button type="button" className="og-skip og-skip--profile button button--ghost" onClick={onSkip}>
              Skip onboarding (preview) <ArrowRight size={14} />
            </button>
          </section>
        ) : (
          <section className="og-hero" aria-labelledby="onboarding-title">
            <h1 id="onboarding-title">Add a model provider</h1>
            <p className="og-lede">
              Choose the provider you already use. You can connect more providers later.
            </p>

            <div className="og-unified">
              <ProviderCatalogue
                providers={providers}
                connectedBackendIds={connectedBackendIds}
                onConnect={handleConnect}
                onCheckConnection={onCheckConnection}
              />
            </div>

            {status ? (
              <p className="og-connection-status-msg" role="status">
                {status}
              </p>
            ) : null}

            {hasAnyConnected ? (
              <div className="og-primary-cta">
                <button type="button" className="og-primary-cta__start" onClick={onSkip}>
                  Start using Fable
                </button>
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

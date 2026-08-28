import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Spinner } from "@phosphor-icons/react/dist/csr/Spinner";
import type { AccountWorkspaceStatus, BackendProvider, BackendVerifyResult } from "@fable/protocol";
import { useState } from "react";
import { ProviderCatalogue } from "../providers/ProviderCatalogue";
import "../../styles/routes/onboarding.css";

type OnboardingStage = "welcome" | "provider" | "teammate";

/**
 * The required minimum journey starts locally: connect a verified provider,
 * then name the first teammate. A Fable account remains optional in Settings.
 */
export function OnboardingPage({
  providers,
  connectedBackendIds,
  status,
  accountWorkspaceStatus,
  accountWorkspacePending,
  onConnect,
  onConnectWithVerify,
  onCheckConnection,
  onStartBrowserLogin,
  initialTeammateName,
  initialTeammatePurpose,
  onConfigureTeammate,
  onComplete
}: {
  providers: BackendProvider[];
  connectedBackendIds: string[];
  status: string | null;
  accountWorkspaceStatus: AccountWorkspaceStatus;
  accountWorkspacePending: boolean;
  /** Legacy fire-and-forget connect used only when verification is unavailable. */
  onConnect?: (providerId: string, secret?: string) => void;
  /** Credentials cross directly into the verified Rust boundary. */
  onConnectWithVerify?: (providerId: string, secret: string) => Promise<BackendVerifyResult>;
  /** Re-probe a provider-owned CLI after the user completes its login flow. */
  onCheckConnection?: (
    providerId: string
  ) => BackendVerifyResult | void | Promise<BackendVerifyResult | void>;
  /** Start an official provider-owned browser sign-in flow. */
  onStartBrowserLogin?: (providerId: string) => Promise<BackendVerifyResult>;
  initialTeammateName: string;
  initialTeammatePurpose: string;
  onConfigureTeammate: (input: { name: string; purpose: string }) => void | Promise<void>;
  onComplete: () => void;
}) {
  const [started, setStarted] = useState(false);
  const [teammateName, setTeammateName] = useState(initialTeammateName);
  const [teammatePurpose, setTeammatePurpose] = useState(initialTeammatePurpose);
  const [finishing, setFinishing] = useState(false);
  const [teammateError, setTeammateError] = useState<string | null>(null);
  const pending = accountWorkspacePending;
  const hasAnyConnected = connectedBackendIds.length > 0;
  const steps: Array<{ id: OnboardingStage; label: string }> = [
    { id: "welcome", label: "Welcome" },
    { id: "provider", label: "Model provider" },
    { id: "teammate", label: "First teammate" }
  ];
  const stage: OnboardingStage = !started
    ? "welcome"
    : !hasAnyConnected
      ? "provider"
      : "teammate";
  const currentStepIndex = Math.max(0, steps.findIndex((entry) => entry.id === stage));

  const handleConnect = async (providerId: string, secret: string): Promise<BackendVerifyResult> => {
    if (onConnectWithVerify) return onConnectWithVerify(providerId, secret);
    onConnect?.(providerId, secret);
    return { providerId, outcome: "ready" };
  };

  return (
    <main className="og-frame" aria-label="Fable onboarding">
      <div className="og-center">
        <nav className="og-progress-container" aria-label="Onboarding progress">
          <ol className="og-progress-steps">
            {steps.map((entry, index) => {
              const complete = index < currentStepIndex;
              const current = index === currentStepIndex;
              return (
                <li
                  key={entry.id}
                  className={`og-progress-step${current ? " is-current" : ""}${complete ? " is-complete" : ""}`}
                  aria-current={current ? "step" : undefined}
                >
                  <span aria-hidden="true">
                    {complete ? <CheckCircle size={14} weight="fill" /> : index + 1}
                  </span>
                  {entry.label}
                </li>
              );
            })}
          </ol>
          <p className="og-progress-status" role="status">
            Step {currentStepIndex + 1} of {steps.length}
          </p>
        </nav>

        {stage === "welcome" ? (
          <section className="og-hero" aria-labelledby="onboarding-title">
            <p className="og-eyebrow">Private by default</p>
            <h1 id="onboarding-title">Meet your teammates on this PC</h1>
            <p className="og-lede">
              Fable gives each teammate private files and a separate browser. Connect a model
              provider you already use, choose what your first teammate should help with, and
              then start working in conversation.
            </p>
            <p className="og-connection-status-msg" role="status">
              {accountWorkspaceStatus.message}
            </p>
            <div className="og-primary-cta">
              <button
                type="button"
                className="og-primary-cta__start"
                disabled={pending}
                onClick={() => setStarted(true)}
              >
                {pending ? <><Spinner size={16} className="og-spinner" /> Preparing Fable</> : "Set up Fable"}
              </button>
            </div>
          </section>
        ) : stage === "provider" ? (
          <section className="og-hero" aria-labelledby="onboarding-title">
            <h1 id="onboarding-title">Add a model provider</h1>
            <p className="og-lede">
              Your private workspace on this PC is ready. Connect and verify a
              provider you already use.
            </p>
            <div className="og-unified">
              <ProviderCatalogue
                providers={providers}
                connectedBackendIds={connectedBackendIds}
                onConnect={handleConnect}
                onCheckConnection={onCheckConnection}
                onStartBrowserLogin={onStartBrowserLogin}
              />
            </div>
            {status ? <p className="og-connection-status-msg" role="status">{status}</p> : null}
          </section>
        ) : (
          <section className="og-hero" aria-labelledby="onboarding-title">
            <h1 id="onboarding-title">Create your first teammate</h1>
            <p className="og-lede">
              Give this teammate a clear name and purpose. You can change both later.
            </p>
            <form
              className="og-form"
              onSubmit={(event) => {
                event.preventDefault();
                const name = teammateName.trim();
                const purpose = teammatePurpose.trim();
                if (!name || !purpose) {
                  setTeammateError("Add both a name and a purpose for your first teammate.");
                  return;
                }
                setFinishing(true);
                setTeammateError(null);
                void Promise.resolve(onConfigureTeammate({ name, purpose }))
                  .then(onComplete)
                  .catch((error) => {
                    setTeammateError(
                      error instanceof Error ? error.message : "Fable could not save this teammate."
                    );
                  })
                  .finally(() => setFinishing(false));
              }}
            >
              <label className="og-field">
                <span>Teammate name</span>
                <input
                  type="text"
                  value={teammateName}
                  maxLength={80}
                  autoComplete="off"
                  disabled={finishing}
                  onChange={(event) => setTeammateName(event.target.value)}
                />
              </label>
              <label className="og-field">
                <span>What should they help with?</span>
                <textarea
                  value={teammatePurpose}
                  maxLength={2_000}
                  rows={4}
                  disabled={finishing}
                  onChange={(event) => setTeammatePurpose(event.target.value)}
                />
              </label>
              {teammateError ? <p className="og-status og-status--error" role="alert">{teammateError}</p> : null}
              {status ? <p className="og-connection-status-msg" role="status">{status}</p> : null}
              <button type="submit" className="og-submit" disabled={finishing}>
                {finishing ? <><Spinner size={16} className="og-spinner" /> Finishing setup</> : "Enter Fable"}
              </button>
            </form>
          </section>
        )}
      </div>
    </main>
  );
}

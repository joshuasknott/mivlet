import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Spinner } from "@phosphor-icons/react/dist/csr/Spinner";
import type { AccountWorkspaceStatus, BackendProvider, BackendVerifyResult, IdentityStatus } from "@fable/protocol";
import { useState } from "react";
import { ProviderCatalogue } from "../providers/ProviderCatalogue";
import "../../styles/routes/onboarding.css";

type AccountStage = "account" | "provider";
type OnboardingStage = "welcome" | "account" | "provider" | "teammate";

function accountStage(identity: IdentityStatus, workspace: AccountWorkspaceStatus): AccountStage {
  if (workspace.accountBound && workspace.state === "ready" && workspace.activeWorkspace.source === "local") {
    return "provider";
  }
  const workspaceUsable = workspace.state === "ready" || (workspace.state === "offline" && workspace.accountBound);
  const identityUsable = identity.state === "signed-in" ||
    (identity.state === "offline" && workspace.state === "offline" && workspace.accountBound);
  return identityUsable && workspaceUsable ? "provider" : "account";
}

function accountActionLabel(identity: IdentityStatus, workspace: AccountWorkspaceStatus): string {
  if (!identity.enabled || identity.state === "disabled" || !workspace.configured) return "Account setup required";
  if (identity.state === "expired" || identity.state === "revoked" || workspace.state === "expired" || workspace.state === "revoked") return "Recover account";
  if (identity.state === "offline" || workspace.state === "offline") return "Try again";
  return "Sign in to Fable";
}

function accountStatusMessage(identity: IdentityStatus, workspace: AccountWorkspaceStatus): string {
  if (identity.state === "error" || identity.state === "expired" || identity.state === "revoked") {
    return identity.message;
  }
  if (workspace.state === "error" || workspace.state === "expired" || workspace.state === "revoked") {
    return workspace.message;
  }
  return workspace.message || identity.message;
}

/**
 * The required minimum journey: a Fable account establishes the active
 * workspace, then the user connects a provider. Account credentials are
 * handled in the system browser; this view never collects them.
 */
export function OnboardingPage({
  providers,
  connectedBackendIds,
  status,
  identityStatus,
  identityPending,
  accountWorkspaceStatus,
  accountWorkspacePending,
  onSignIn,
  onRecover,
  onRefreshAccount,
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
  identityStatus: IdentityStatus;
  identityPending: boolean;
  accountWorkspaceStatus: AccountWorkspaceStatus;
  accountWorkspacePending: boolean;
  onSignIn: () => void | Promise<void>;
  onRecover: () => void | Promise<void>;
  onRefreshAccount: () => void | Promise<void>;
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
  const account = accountStage(identityStatus, accountWorkspaceStatus);
  const pending = identityPending || accountWorkspacePending;
  const hasAnyConnected = connectedBackendIds.length > 0;
  const display = identityStatus.authentication?.verifiedDisplayAttributes;
  const localOnly = accountWorkspaceStatus.activeWorkspace.source === "local";
  const steps: Array<{ id: OnboardingStage; label: string }> = [
    { id: "welcome", label: "Welcome" },
    ...(!localOnly ? [{ id: "account" as const, label: "Fable account" }] : []),
    { id: "provider", label: "Model provider" },
    { id: "teammate", label: "First teammate" }
  ];
  const stage: OnboardingStage = !started
    ? "welcome"
    : account === "account"
      ? "account"
      : !hasAnyConnected
        ? "provider"
        : "teammate";
  const currentStepIndex = Math.max(0, steps.findIndex((entry) => entry.id === stage));

  const handleConnect = async (providerId: string, secret: string): Promise<BackendVerifyResult> => {
    if (onConnectWithVerify) return onConnectWithVerify(providerId, secret);
    onConnect?.(providerId, secret);
    return { providerId, outcome: "ready" };
  };

  const handleAccountAction = () => {
    const needsRecovery = ["expired", "revoked"].includes(identityStatus.state) ||
      ["expired", "revoked"].includes(accountWorkspaceStatus.state);
    void (needsRecovery ? onRecover() : onSignIn());
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
        ) : stage === "account" ? (
          <section className="og-hero" aria-labelledby="onboarding-title">
            <h1 id="onboarding-title">Start with your Fable account</h1>
            <p className="og-lede">
              Your account securely opens your Fable workspace. Sign-in and recovery happen in your system browser; Fable never asks for your account password.
            </p>
            {display?.displayName || display?.email ? (
              <p className="og-connection-status-msg" role="status">Signed in as {display.displayName ?? display.email}.</p>
            ) : null}
            <p className="og-connection-status-msg" role={identityStatus.state === "error" || accountWorkspaceStatus.state === "error" ? "alert" : "status"}>
              {accountStatusMessage(identityStatus, accountWorkspaceStatus)}
            </p>
            <div className="og-primary-cta">
              <button type="button" className="og-primary-cta__start" disabled={pending || !identityStatus.enabled || !accountWorkspaceStatus.configured} onClick={handleAccountAction}>
                {pending ? <Spinner size={16} aria-hidden="true" /> : null}
                {accountActionLabel(identityStatus, accountWorkspaceStatus)}
              </button>
              {(identityStatus.state === "offline" || accountWorkspaceStatus.state === "offline" || identityStatus.state === "error" || accountWorkspaceStatus.state === "error") ? (
                <button type="button" className="button button--ghost" disabled={pending} onClick={() => void onRefreshAccount()}>
                  <ArrowClockwise size={15} /> Refresh status
                </button>
              ) : null}
            </div>
          </section>
        ) : stage === "provider" ? (
          <section className="og-hero" aria-labelledby="onboarding-title">
            <h1 id="onboarding-title">Add a model provider</h1>
            <p className="og-lede">{localOnly
              ? "Your private workspace on this PC is ready. Connect and verify a provider you already use."
              : "Choose a provider you already use. You can connect more later."}</p>
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

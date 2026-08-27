import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Spinner } from "@phosphor-icons/react/dist/csr/Spinner";
import type { AccountWorkspaceStatus, BackendProvider, BackendVerifyResult, IdentityStatus } from "@fable/protocol";
import { ProviderCatalogue } from "../providers/ProviderCatalogue";
import "../../styles/routes/onboarding.css";

type AccountStage = "account" | "provider";

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
  onComplete
  ,allowProviderless = false
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
  onCheckConnection?: (providerId: string) => void | Promise<void>;
  onComplete: () => void;
  allowProviderless?: boolean;
}) {
  const step = accountStage(identityStatus, accountWorkspaceStatus);
  const pending = identityPending || accountWorkspacePending;
  const hasAnyConnected = connectedBackendIds.length > 0;
  const display = identityStatus.authentication?.verifiedDisplayAttributes;
  const localOnly = accountWorkspaceStatus.activeWorkspace.source === "local";

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
            <li className={step === "account" ? "og-progress-step is-current" : "og-progress-step is-complete"} aria-current={step === "account" ? "step" : undefined}>
              <span aria-hidden="true">{step === "provider" ? <CheckCircle size={14} weight="fill" /> : "1"}</span>
              {localOnly ? "Local workspace" : "Fable account"}
            </li>
            <li className={step === "provider" ? "og-progress-step is-current" : "og-progress-step"} aria-current={step === "provider" ? "step" : undefined}>
              <span aria-hidden="true">2</span>
              Model provider
            </li>
          </ol>
          <p className="og-progress-status" role="status">Step {step === "account" ? "1" : "2"} of 2</p>
        </nav>

        {step === "account" ? (
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
        ) : (
          <section className="og-hero" aria-labelledby="onboarding-title">
            <h1 id="onboarding-title">Add a model provider</h1>
            <p className="og-lede">{localOnly
              ? "Your private workspace on this PC is ready. Connect a provider you already use, or continue now and add one later."
              : "Choose a provider you already use. You can connect more later."}</p>
            <div className="og-unified">
              <ProviderCatalogue providers={providers} connectedBackendIds={connectedBackendIds} onConnect={handleConnect} onCheckConnection={onCheckConnection} />
            </div>
            {status ? <p className="og-connection-status-msg" role="status">{status}</p> : null}
            <div className="og-primary-cta">
              <button type="button" className="og-primary-cta__start" disabled={!hasAnyConnected} onClick={onComplete}>Start using Fable</button>
              {!hasAnyConnected && allowProviderless ? <button type="button" className="og-primary-cta__secondary" onClick={onComplete}>Continue without a provider</button> : null}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

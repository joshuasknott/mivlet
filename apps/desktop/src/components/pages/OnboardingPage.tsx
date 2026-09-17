import type { IdentityStatus } from "@mivlet/protocol";

import { Spinner } from "@phosphor-icons/react/dist/csr/Spinner";
import { useEffect, useRef, useState } from "react";
import { Brand } from "../Brand";

import "../../styles/routes/onboarding.css";

/** Account entry only; the shell then checks required provider setup. */
export function OnboardingPage({
  identityStatus,
  identityPending,
  workspaceMessage,
  onSignIn,
  onOpenWorkspace,
}: {
  identityStatus: IdentityStatus;
  identityPending: boolean;
  workspaceMessage: string;
  onSignIn: () => void | Promise<void>;
  onOpenWorkspace: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState("");

  const headingRef = useRef<HTMLHeadingElement>(null);
  const actionPending = useRef(false);
  const signedIn =
    identityStatus.state === "signed-in" ||
    (identityStatus.state === "offline" &&
      Boolean(identityStatus.authentication));
  const busy = identityPending || pending;

  useEffect(() => {
    headingRef.current?.focus();
  }, [signedIn]);

  const enter = async () => {
    if (identityPending || actionPending.current) return;
    actionPending.current = true;
    setPending(true);
    setAttempted(true);
    setError("");
    try {
      if (signedIn) await onOpenWorkspace();
      else await onSignIn();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Your account could not open. Try again.",
      );
    } finally {
      actionPending.current = false;
      setPending(false);
    }
  };

  return (
    <main className="og-frame" aria-label="Mivlet account">
      <div className="og-center">
        <Brand compact className="og-brand" />
        <section
          className="og-screen og-screen--account"
          aria-labelledby="onboarding-title"
        >
          <div className="og-heading">
            <h1 ref={headingRef} tabIndex={-1} id="onboarding-title">
              {signedIn ? "Open your workspace" : "Welcome to Mivlet"}
            </h1>
            <p>{signedIn ? workspaceMessage : "Your personal AI workspace"}</p>
          </div>
          <div className="og-account-actions">
            {signedIn ? (
              <button
                type="button"
                className="og-primary-button"
                disabled={busy}
                onClick={() => void enter()}
              >
                {busy ? (
                  <>
                    <Spinner size={17} className="og-spinner" /> Opening
                    workspace
                  </>
                ) : (
                  "Try opening workspace again"
                )}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="og-primary-button"
                  disabled={busy}
                  onClick={() => void enter()}
                >
                  {busy ? (
                    <>
                      <Spinner size={17} className="og-spinner" /> Opening sign
                      in
                    </>
                  ) : (
                    "Log in"
                  )}
                </button>
                <button
                  type="button"
                  className="og-secondary-button"
                  disabled={busy}
                  onClick={() => void enter()}
                >
                  Sign up
                </button>
              </>
            )}
          </div>
          {error ? (
            <p className="og-feedback og-feedback--danger" role="alert">
              {error}
            </p>
          ) : attempted && !signedIn ? (
            <p
              className={`og-feedback${identityStatus.state === "error" || identityStatus.state === "disabled" ? " og-feedback--danger" : ""}`}
              role={
                identityStatus.state === "error" ||
                identityStatus.state === "disabled"
                  ? "alert"
                  : "status"
              }
            >
              {identityStatus.message}
            </p>
          ) : null}
        </section>
      </div>
    </main>
  );
}

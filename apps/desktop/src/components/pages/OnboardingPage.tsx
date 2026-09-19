import type { IdentityStatus } from "@mivlet/protocol";

import { Spinner } from "@phosphor-icons/react/dist/csr/Spinner";
import { useEffect, useRef, useState } from "react";
import { Brand } from "../Brand";
import { LegalFooter } from "./LegalFooter";

import "../../styles/routes/onboarding.css";

/** Account entry only; the shell then checks required provider setup. */
export function OnboardingPage({
  identityStatus,
  identityPending,
  workspaceMessage,
  onSignIn,
  onCancelSignIn,
  onSignOut,
  onOpenWorkspace,
}: {
  identityStatus: IdentityStatus;
  identityPending: boolean;
  workspaceMessage: string;
  onSignIn: (mode: "sign-in" | "sign-up") => void | Promise<void>;
  onCancelSignIn: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onOpenWorkspace: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState("");
  const [entryMode, setEntryMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [cancelling, setCancelling] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const request = useRef(0);

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

  const enter = async (mode: "sign-in" | "sign-up" = "sign-in") => {
    if (identityPending || actionPending.current) return;
    actionPending.current = true;
    const generation = ++request.current;
    setEntryMode(mode);
    setPending(true);
    setAttempted(true);
    setError("");
    try {
      if (signedIn) await onOpenWorkspace();
      else await onSignIn(mode);
    } catch (cause) {
      if (generation !== request.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Your account could not open. Try again.",
      );
    } finally {
      if (generation === request.current) {
        actionPending.current = false;
        setPending(false);
      }
    }
  };

  const back = async () => {
    setCancelling(true);
    setError("");
    try {
      await onCancelSignIn();
      ++request.current;
      actionPending.current = false;
      setPending(false);
      headingRef.current?.focus();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not cancel sign-in. Try again.",
      );
    } finally {
      setCancelling(false);
    }
  };
  const signOut = async () => {
    setSigningOut(true);
    try {
      await onSignOut();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign out.");
    } finally {
      setSigningOut(false);
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
              {signedIn ? "Open your workspace" : "Start using Mivlet"}
            </h1>
            {signedIn && <p>{workspaceMessage}</p>}
          </div>
          <div className="og-account-actions">
            {signedIn ? (
              <>
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
                <button
                  type="button"
                  className="og-secondary-button"
                  disabled={signingOut}
                  onClick={() => void signOut()}
                >
                  {signingOut ? "Returning to login…" : "Back to login"}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="og-primary-button"
                  disabled={busy}
                  onClick={() => void enter()}
                >
                  {busy && entryMode === "sign-in" ? (
                    <>
                      <Spinner size={17} className="og-spinner" /> Waiting for
                      login
                    </>
                  ) : (
                    "Log in"
                  )}
                </button>
                <button
                  type="button"
                  className="og-secondary-button"
                  disabled={busy}
                  onClick={() => void enter("sign-up")}
                >
                  {busy && entryMode === "sign-up" ? (
                    <>
                      <Spinner size={17} className="og-spinner" /> Waiting for
                      sign-up
                    </>
                  ) : (
                    "Create an account"
                  )}
                </button>
                {busy && (
                  <button
                    type="button"
                    className="og-secondary-button"
                    disabled={cancelling}
                    onClick={() => void back()}
                  >
                    {cancelling ? "Cancelling…" : "Back"}
                  </button>
                )}
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
      {!signedIn && <LegalFooter />}
    </main>
  );
}

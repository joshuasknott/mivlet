import { useEffect, useState } from "react";
import { Brand } from "../Brand";
import "../../styles/routes/onboarding.css";

/** Keep recovery reachable even if the native process stops answering. */
export function WorkspaceLoadingPage({
  onRetry,
  onSignOut,
  failure,
}: {
  onRetry: () => Promise<void>;
  onSignOut: () => Promise<void>;
  failure?: string | null;
}) {
  const [slow, setSlow] = useState(false);
  const [pending, setPending] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 10_000);
    return () => window.clearTimeout(timer);
  }, []);
  const run = async (action: () => Promise<void>, leave = false) => {
    const setBusy = leave ? setLeaving : setPending;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not open your workspace.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="og-frame">
      <div className="og-center">
        <Brand compact className="og-brand" />
        <section className="og-screen">
          <div className="og-heading">
            <h1>Opening your workspace</h1>
            <p role="status">
              {failure ||
                (slow
                  ? "This is taking longer than expected. You can retry or return to login."
                  : "Checking your account and loading this device’s workspace…")}
            </p>
          </div>
          {(slow || failure) && (
            <div className="og-account-actions">
              <button
                className="og-primary-button"
                disabled={pending || leaving}
                onClick={() => void run(onRetry)}
              >
                Try again
              </button>
              <button
                className="og-secondary-button"
                disabled={leaving}
                onClick={() => void run(onSignOut, true)}
              >
                Back to login
              </button>
            </div>
          )}
          {error && (
            <p className="og-feedback og-feedback--danger" role="alert">
              {error}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}

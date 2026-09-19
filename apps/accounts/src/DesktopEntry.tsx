import { useEffect, useRef, useState } from "react";
import { useClerk } from "@clerk/react";
import {
  desktopEntry,
  clearDesktopContinuation,
  desktopContinuation,
  desktopFormUrl,
  openDesktopEntry,
} from "./desktop-entry";

export function DesktopEntry() {
  const clerk = useClerk();
  const started = useRef(false);
  const [error, setError] = useState("");
  const [choice, setChoice] = useState<ReturnType<typeof desktopEntry> | null>(
    null,
  );
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const entry = desktopEntry(
          window.location.search,
          import.meta.env.VITE_CLERK_ISSUER?.trim() ?? "",
          import.meta.env.VITE_CLERK_OAUTH_CLIENT_ID?.trim() ?? "",
        );
        const destination = desktopFormUrl(entry, window.location.origin);
        clearDesktopContinuation(window.sessionStorage);
        desktopContinuation(
          window.location.search,
          import.meta.env.VITE_CLERK_ISSUER?.trim() ?? "",
          import.meta.env.VITE_CLERK_OAUTH_CLIENT_ID?.trim() ?? "",
          window.sessionStorage,
        );
        // Never silently discard an authenticated browser session. The user
        // can reuse it or deliberately select another account below.
        if (clerk.session) {
          setChoice(entry);
          return;
        }
        await openDesktopEntry(
          destination,
          undefined,
          (options) => clerk.signOut(options),
          (url) => window.location.replace(url),
          entry.mode === "sign-in" ? entry.authorizationUrl : undefined,
        );
      } catch {
        setError(
          "Your account page could not open. Check the account service configuration and try again from Mivlet.",
        );
      }
    })();
  }, [clerk]);
  if (choice && !error)
    return (
      <section className="account-message">
        <h1>Continue to Mivlet</h1>
        <p>
          You’re already signed in
          {clerk.user?.primaryEmailAddress?.emailAddress
            ? ` as ${clerk.user.primaryEmailAddress.emailAddress}`
            : " in this browser"}
          .
        </p>
        <div className="account-entry-actions">
          <button
            disabled={switching}
            onClick={() => window.location.replace(choice.authorizationUrl)}
          >
            Continue with this account
          </button>
          <button
            disabled={switching}
            onClick={() => {
              setSwitching(true);
              void openDesktopEntry(
                desktopFormUrl(choice, window.location.origin),
                clerk.session?.id,
                (options) => clerk.signOut(options),
                (url) => window.location.replace(url),
              ).catch(() => {
                setError(
                  "Could not switch accounts. Reload this page to try again.",
                );
                setSwitching(false);
              });
            }}
          >
            {switching
              ? "Opening…"
              : choice.mode === "sign-up"
                ? "Create another account"
                : "Use another account"}
          </button>
        </div>
      </section>
    );
  return (
    <section className="account-message" role={error ? "alert" : "status"}>
      <h1>{error ? "Account unavailable" : "Opening your account"}</h1>
      <p>{error || "Please wait…"}</p>
    </section>
  );
}

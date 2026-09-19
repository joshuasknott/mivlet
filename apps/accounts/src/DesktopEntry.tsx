import { useEffect, useRef, useState } from "react";
import { useClerk } from "@clerk/react";
import {
  desktopEntry,
  desktopFormUrl,
  openDesktopEntry,
} from "./desktop-entry";

export function DesktopEntry() {
  const clerk = useClerk();
  const started = useRef(false);
  const [error, setError] = useState("");
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
        // Explicit desktop entry starts a fresh choice. Only sign out this
        // instance's active session, not every account in a multi-session app.
        // Run only on /desktop/start, never on verification/callback routes.
        await openDesktopEntry(
          destination,
          clerk.session?.id,
          (options) => clerk.signOut(options),
          (url) => window.location.replace(url),
        );
      } catch {
        setError(
          "Your account page could not open. Check the account service configuration and try again from Mivlet.",
        );
      }
    })();
  }, [clerk]);
  return (
    <section className="account-message" role={error ? "alert" : "status"}>
      <h1>{error ? "Account unavailable" : "Opening your account"}</h1>
      <p>{error || "Please wait…"}</p>
    </section>
  );
}

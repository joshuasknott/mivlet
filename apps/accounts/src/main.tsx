import { StrictMode, useEffect, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  ClerkProvider,
  ClerkLoading,
  ClerkLoaded,
  ClerkFailed,
  SignIn,
  SignUp,
  OAuthConsent,
  Show,
  RedirectToSignIn,
} from "@clerk/react";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import { appearance, localization } from "./appearance";
import { accountRoute } from "./routes";
import { DesktopEntry } from "./DesktopEntry";
import { desktopContinuation, desktopFormUrl } from "./desktop-entry";
import symbol from "../../desktop/public/brand/mivlet-symbol-light.png";
import "./styles.css";
import { LegalDocument } from "../../desktop/src/components/pages/LegalDocument";
import "../../desktop/src/components/pages/legal.css";

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="account-message">
      <img src={symbol} width="110" height="61" alt="Mivlet" />
      <h1>{title}</h1>
      <p>{children}</p>
    </section>
  );
}

function CompleteDesktop({ authorizationUrl }: { authorizationUrl?: string }) {
  const started = useRef(false);
  useEffect(() => {
    if (authorizationUrl && !started.current) {
      started.current = true;
      window.location.replace(authorizationUrl);
    }
  }, [authorizationUrl]);
  return (
    <Message
      title={
        authorizationUrl ? "Returning to Mivlet" : "Browser sign-in complete"
      }
    >
      {authorizationUrl ? (
        <>
          Finishing desktop authorization…{" "}
          <a href={authorizationUrl}>Continue to Mivlet</a>
        </>
      ) : (
        "This browser session is signed in. Open Log in in Mivlet to connect it to your workspace; you can reuse this account."
      )}
    </Message>
  );
}

function AccountPage() {
  const route = accountRoute(window.location.pathname);
  if (route === "desktop-entry") return <DesktopEntry />;
  let continuation: string | undefined;
  let signInUrl = "/sign-in";
  let signUpUrl = "/sign-up";
  if (
    route === "sign-in" ||
    route === "sign-up" ||
    route === "complete" ||
    route === "consent"
  ) {
    try {
      const entry = desktopContinuation(
        window.location.search,
        import.meta.env.VITE_CLERK_ISSUER?.trim() ?? "",
        import.meta.env.VITE_CLERK_OAUTH_CLIENT_ID?.trim() ?? "",
        window.sessionStorage,
      );
      if (entry) {
        continuation = entry.authorizationUrl;
        signInUrl = desktopFormUrl(
          { ...entry, mode: "sign-in" },
          window.location.origin,
        );
        signUpUrl = desktopFormUrl(
          { ...entry, mode: "sign-up" },
          window.location.origin,
        );
      }
    } catch {
      return (
        <Message title="Account unavailable">
          Start again from Mivlet to open your account.
        </Message>
      );
    }
  }
  if (route === "consent")
    return (
      <>
        <Show when="signed-in">
          <OAuthConsent />
        </Show>
        <Show when="signed-out">
          <RedirectToSignIn redirectUrl={window.location.href} />
        </Show>
      </>
    );
  if (route === "sign-up")
    return (
      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl={signInUrl}
        forceRedirectUrl={continuation}
        signInForceRedirectUrl={continuation}
      />
    );
  if (route === "sign-in")
    return (
      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl={signUpUrl}
        forceRedirectUrl={continuation}
        signUpForceRedirectUrl={continuation}
      />
    );
  if (route === "not-found")
    return (
      <Message title="Page not found">
        <a href="/sign-in">Go to log in</a>
      </Message>
    );
  return (
    <>
      <Show when="signed-out">
        <RedirectToSignIn />
      </Show>
      <Show when="signed-in">
        <CompleteDesktop authorizationUrl={continuation} />
      </Show>
    </>
  );
}

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main className="account-page" aria-label="Mivlet account">
      {["/terms", "/privacy"].includes(window.location.pathname) ? (
        <LegalDocument
          kind={window.location.pathname === "/terms" ? "terms" : "privacy"}
        />
      ) : publishableKey ? (
        <ClerkProvider
          publishableKey={publishableKey}
          allowedRedirectOrigins={
            import.meta.env.VITE_CLERK_ISSUER
              ? [import.meta.env.VITE_CLERK_ISSUER]
              : []
          }
          appearance={appearance}
          localization={localization}
          signInUrl="/sign-in"
          signUpUrl="/sign-up"
          signInFallbackRedirectUrl="/complete"
          signUpFallbackRedirectUrl="/complete"
        >
          <ClerkLoading>
            <Message title="Opening your account">Please wait…</Message>
          </ClerkLoading>
          <ClerkFailed>
            <Message title="Your account could not open">
              Check your connection and reload this page.
            </Message>
          </ClerkFailed>
          <ClerkLoaded>
            <AccountPage />
          </ClerkLoaded>
        </ClerkProvider>
      ) : (
        <Message title="Account setup required">
          The account service is not configured. Please contact the app owner.
        </Message>
      )}
      <footer className="mivlet-legal-footer">
        Read our{" "}
        <a href="/terms" target="_blank" rel="noopener noreferrer">
          Terms of Service
        </a>{" "}
        and{" "}
        <a href="/privacy" target="_blank" rel="noopener noreferrer">
          Privacy Policy
        </a>
      </footer>
    </main>
  </StrictMode>,
);

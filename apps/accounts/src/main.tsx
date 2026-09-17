import { StrictMode, type ReactNode } from "react";
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
import symbol from "../../desktop/public/brand/mivlet-symbol-light.png";
import "./styles.css";

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="account-message">
      <img src={symbol} width="110" height="61" alt="Mivlet" />
      <h1>{title}</h1>
      <p>{children}</p>
    </section>
  );
}

function AccountPage() {
  const route = accountRoute(window.location.pathname);
  if (route === "consent")
    return (
      <>
        <Show when="signed-in">
          <OAuthConsent />
        </Show>
        <Show when="signed-out">
          <RedirectToSignIn />
        </Show>
      </>
    );
  if (route === "sign-up")
    return <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" />;
  if (route === "sign-in")
    return <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />;
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
        <Message title="Your account is ready">
          Return to Mivlet to continue. If the desktop app is still waiting,
          start Log in again there.
        </Message>
      </Show>
    </>
  );
}

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main className="account-page" aria-label="Mivlet account">
      {publishableKey ? (
        <ClerkProvider
          publishableKey={publishableKey}
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
    </main>
  </StrictMode>,
);

import { useState, type ReactNode } from "react";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import { Brand } from "../Brand";
import { ProviderCatalogue } from "../providers/ProviderCatalogue";
import "../../styles/routes/provider-onboarding.css";

type ProviderSetupRuntime = Pick<
  ShellRuntime,
  | "backendProviders"
  | "connectedBackendIds"
  | "connectBackendWithVerify"
  | "checkBackendConnection"
  | "startBackendBrowserLogin"
  | "refreshModels"
  | "signOutIdentity"
>;

function ProviderOnboardingPage({
  runtime,
}: {
  runtime: ProviderSetupRuntime;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState("");
  return (
    <main className="provider-onboarding" aria-label="Connect your AI">
      <Brand compact className="provider-onboarding__brand" />
      <ProviderCatalogue
        onboarding
        providers={runtime.backendProviders}
        connectedBackendIds={runtime.connectedBackendIds}
        onConnect={runtime.connectBackendWithVerify}
        onCheckConnection={runtime.checkBackendConnection}
        onStartBrowserLogin={runtime.startBackendBrowserLogin}
        onRefreshModels={runtime.refreshModels}
      />
      {error && <p role="alert">{error}</p>}
      <button
        className="provider-onboarding__signout"
        disabled={signingOut}
        onClick={async () => {
          setSigningOut(true);
          setError("");
          try {
            await runtime.signOutIdentity();
          } catch (cause) {
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not sign out. Try again.",
            );
          } finally {
            setSigningOut(false);
          }
        }}
      >
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
    </main>
  );
}

export function ProviderOnboardingGate({
  runtime,
  children,
}: {
  runtime: ProviderSetupRuntime & Pick<ShellRuntime, "connectedAgentBackends">;
  children: ReactNode;
}) {
  return runtime.connectedAgentBackends.length ? (
    children
  ) : (
    <ProviderOnboardingPage runtime={runtime} />
  );
}

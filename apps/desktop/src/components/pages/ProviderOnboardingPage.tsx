import { lazy, Suspense, useState, type ReactNode } from "react";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import { Brand } from "../Brand";
import { ProviderCatalogue } from "../providers/ProviderCatalogue";
import "../../styles/routes/provider-onboarding.css";

const PortableTransferSettings = lazy(() => import("../settings/PortableTransferSettings").then(module => ({ default: module.PortableTransferSettings })));

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
  const [transferOpen, setTransferOpen] = useState(false);
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
      <details className="settings-disclosure" onToggle={(event) => setTransferOpen(event.currentTarget.open)}>
        <summary>Move history from another computer</summary>
        {transferOpen && <Suspense fallback={<p role="status">Loading transfer controls…</p>}><PortableTransferSettings mode="import" /></Suspense>}
      </details>
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
        {signingOut ? "Returning to login…" : "Back to login"}
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

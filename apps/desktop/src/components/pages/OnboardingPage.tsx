import { Brand } from "../Brand";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { GoogleLogo } from "@phosphor-icons/react/dist/csr/GoogleLogo";
import { Spinner } from "@phosphor-icons/react/dist/csr/Spinner";
import type {
  BackendProvider,
  BackendVerifyResult,
  ConnectorManifest,
  IdentityStatus,
} from "@fable/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { ConnectorIcon } from "../ConnectorIcon";
import { PrivacyNotice } from "../settings/PrivacyNotice";
import { OnboardingProviderStep } from "./OnboardingProviderStep";
import "../../styles/routes/onboarding.css";

type OnboardingStage = "account" | "provider" | "connectors";
type AccountEntryPoint = "google" | "email";

const ONBOARDING_CONNECTOR_IDS = [
  "google-drive",
  "github",
  "slack",
  "notion",
  "linear",
] as const;

function identityReady(identityStatus: IdentityStatus): boolean {
  return (
    identityStatus.state === "signed-in" ||
    (identityStatus.state === "offline" &&
      Boolean(identityStatus.authentication))
  );
}

export function OnboardingPage({
  providers,
  connectedBackendIds,
  status,
  identityStatus,
  identityPending,
  onSignIn,
  onConnectWithVerify,
  onCheckConnection,
  onStartBrowserLogin,
  connectors,
  connectorStatus,
  onConnectConnector,
  onComplete,
}: {
  providers: BackendProvider[];
  connectedBackendIds: string[];
  status: string | null;
  identityStatus: IdentityStatus;
  identityPending: boolean;
  onSignIn: (entryPoint: AccountEntryPoint) => void | Promise<void>;
  /** Credentials cross directly into the verified Rust boundary. */
  onConnectWithVerify: (
    providerId: string,
    secret: string,
  ) => Promise<BackendVerifyResult>;
  /** Re-probe a provider-owned CLI after the user completes its login flow. */
  onCheckConnection?: (
    providerId: string,
  ) => BackendVerifyResult | void | Promise<BackendVerifyResult | void>;
  /** Start an official provider-owned browser sign-in flow. */
  onStartBrowserLogin?: (providerId: string) => Promise<BackendVerifyResult>;
  connectors: ConnectorManifest[];
  connectorStatus: string | null;
  onConnectConnector: (connector: ConnectorManifest) => void | Promise<void>;
  onComplete: () => void;
}) {
  const [stage, setStage] = useState<OnboardingStage>("account");
  const [accountActionPending, setAccountActionPending] = useState(false);
  const [accountAttempted, setAccountAttempted] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [activeConnectorId, setActiveConnectorId] = useState<string | null>(
    null,
  );
  const [connectorError, setConnectorError] = useState("");
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const visibleConnectors = useMemo(
    () =>
      ONBOARDING_CONNECTOR_IDS.flatMap((id) => {
        const connector = connectors.find((candidate) => candidate.id === id);
        return connector ? [connector] : [];
      }),
    [connectors],
  );
  const currentStepIndex =
    stage === "account" ? 0 : stage === "provider" ? 1 : 2;
  const signedIn = identityReady(identityStatus);

  const handleAccountEntry = async (entryPoint: AccountEntryPoint) => {
    if (identityPending || accountActionPending) return;
    if (signedIn) {
      setStage("provider");
      return;
    }
    setAccountActionPending(true);
    setAccountAttempted(true);
    setAccountError("");
    try {
      await onSignIn(entryPoint);
    } catch (error) {
      setAccountError(
        error instanceof Error
          ? error.message
          : "Sign-in could not open. Try again.",
      );
    } finally {
      setAccountActionPending(false);
    }
  };

  useEffect(() => {
    if (accountAttempted && signedIn) setStage("provider");
  }, [accountAttempted, signedIn]);

  useEffect(() => {
    headingRef.current?.focus();
  }, [stage]);

  const handleConnectorConnect = async (connector: ConnectorManifest) => {
    if (activeConnectorId || connector.status === "connected") return;
    setActiveConnectorId(connector.id);
    setConnectorError("");
    try {
      await onConnectConnector(connector);
    } catch (error) {
      setConnectorError(
        error instanceof Error
          ? error.message
          : `${connector.name} could not connect. Try again.`,
      );
    } finally {
      setActiveConnectorId(null);
    }
  };

  return (
    <main className="og-frame" aria-label="Mivlet onboarding">
      {stage !== "account" ? (
        <button
          type="button"
          className="og-back-button"
          onClick={() =>
            setStage(stage === "connectors" ? "provider" : "account")
          }
        >
          <ArrowLeft size={17} aria-hidden="true" /> Back
        </button>
      ) : null}
      <div className="og-center">
        <Brand className="og-brand" />


        {stage === "account" ? (
          <section
            className="og-screen og-screen--account"
            aria-labelledby="onboarding-title"
          >
            <div className="og-heading">
              <h1 ref={headingRef} tabIndex={-1} id="onboarding-title">
                Welcome to Mivlet
              </h1>
              <p>Sign in or create an account to get started.</p>
            </div>

            <div className="og-account-actions">
              <button
                type="button"
                className="og-primary-button og-primary-button--google"
                disabled={identityPending || accountActionPending}
                onClick={() => void handleAccountEntry("google")}
              >
                {identityPending || accountActionPending ? (
                  <>
                    <Spinner size={17} className="og-spinner" /> Opening sign in
                  </>
                ) : (
                  <>
                    <GoogleLogo size={20} weight="bold" aria-hidden="true" />{" "}
                    Continue with Google
                  </>
                )}
              </button>
              <button
                type="button"
                className="og-text-button"
                disabled={identityPending || accountActionPending}
                onClick={() => void handleAccountEntry("email")}
              >
                Continue with email
              </button>
            </div>

            {accountError ? (
              <p className="og-feedback og-feedback--danger" role="alert">
                {accountError}
              </p>
            ) : accountAttempted && !signedIn ? (
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

            <button
              type="button"
              className="og-privacy-link"
              onClick={() => setPrivacyOpen(true)}
            >
              Privacy &amp; data
            </button>
          </section>
        ) : stage === "provider" ? (
          <section className="og-screen" aria-labelledby="onboarding-title">
            <div className="og-heading">
              <h1 ref={headingRef} tabIndex={-1} id="onboarding-title">
                Choose your provider
              </h1>
              <p>Connect an account or use an API key.</p>
            </div>
            <OnboardingProviderStep
              providers={providers}
              connectedBackendIds={connectedBackendIds}
              onConnect={onConnectWithVerify}
              onCheckConnection={onCheckConnection}
              onStartBrowserLogin={onStartBrowserLogin}
              onReady={() => setStage("connectors")}
            />
            {status ? (
              <p className="og-feedback" role="status">
                {status}
              </p>
            ) : null}
          </section>
        ) : (
          <section className="og-screen" aria-labelledby="onboarding-title">
            <div className="og-heading">
              <h1 ref={headingRef} tabIndex={-1} id="onboarding-title">
                Connect the apps you use
              </h1>
              <p>You can do this later.</p>
            </div>

            <div className="og-icon-choices" aria-label="Apps to connect">
              {visibleConnectors.map((connector) => {
                const connected = connector.status === "connected";
                const pending = activeConnectorId === connector.id;
                const unavailable =
                  connector.status === "unavailable" ||
                  connector.status === "unconfigured";
                return (
                  <button
                    key={connector.id}
                    type="button"
                    className={`og-icon-choice${connected ? " is-selected is-connected" : ""}`}
                    aria-label={`${connected ? "Connected: " : "Connect "}${connector.name}`}
                    title={
                      unavailable
                        ? `${connector.name}: This connection is not available in this build.`
                        : connector.name
                    }
                    disabled={
                      activeConnectorId !== null || unavailable || connected
                    }
                    onClick={() => void handleConnectorConnect(connector)}
                  >
                    {pending ? (
                      <Spinner size={24} className="og-spinner" />
                    ) : (
                      <ConnectorIcon id={connector.id} />
                    )}
                    {connected ? (
                      <span
                        className="og-icon-choice__check"
                        aria-hidden="true"
                      >
                        <Check size={11} weight="bold" />
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            <div className="og-connector-actions">
              <button
                type="button"
                className="og-primary-button"
                onClick={onComplete}
              >
                Enter Mivlet
              </button>
              <button
                type="button"
                className="og-text-button"
                onClick={onComplete}
              >
                Skip for now
              </button>
            </div>
            {connectorError ? (
              <p className="og-feedback og-feedback--danger" role="alert">
                {connectorError}
              </p>
            ) : connectorStatus ? (
              <p className="og-feedback" role="status">
                {connectorStatus}
              </p>
            ) : null}
          </section>
        )}
      </div>
      <div
        className="og-progress"
        aria-label={`Onboarding step ${currentStepIndex + 1} of 3`}
      >
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className={index === currentStepIndex ? "is-current" : undefined}
            aria-hidden="true"
          />
        ))}
      </div>
      {privacyOpen ? (
        <PrivacyNotice onClose={() => setPrivacyOpen(false)} />
      ) : null}
    </main>
  );
}

import { Spinner } from "@phosphor-icons/react/dist/csr/Spinner";
import type { BackendProvider, BackendVerifyResult } from "@fable/protocol";
import { useEffect, useMemo, useState } from "react";
import { connectResultCopy } from "../../lib/backend-state";
import { ProviderIcon } from "../ProviderIcon";
import {
  buildProviderFamilies,
  encodeCustomProviderSecret,
  type ProviderConnectionMethod,
  type ProviderFamily,
} from "../providers/ProviderCatalogue";

const ONBOARDING_PROVIDER_FAMILY_IDS = [
  "openai",
  "anthropic",
  "antigravity",
  "xai",
] as const;

interface OnboardingProviderStepProps {
  providers: BackendProvider[];
  connectedBackendIds: string[];
  onConnect: (
    providerId: string,
    secret: string,
  ) => Promise<BackendVerifyResult>;
  onCheckConnection?: (
    providerId: string,
  ) => BackendVerifyResult | void | Promise<BackendVerifyResult | void>;
  onStartBrowserLogin?: (providerId: string) => Promise<BackendVerifyResult>;
  onReady: () => void;
}

function connectedFamily(
  family: ProviderFamily,
  connectedBackendIds: string[],
): boolean {
  return family.providers.some(
    (provider) =>
      connectedBackendIds.includes(provider.id) ||
      provider.authState === "connected" ||
      provider.authState === "ready",
  );
}

function providerButtonLabel(family: ProviderFamily): string {
  if (family.id === "openai") return "OpenAI and ChatGPT";
  return family.label;
}

function credentialLinkLabel(family: ProviderFamily): string {
  if (family.id === "openai") return "Use an OpenAI API key instead";
  const method = family.methods.find(
    (candidate) => candidate.kind === "api-key",
  );
  return method
    ? `Use ${method.provider.label} API key instead`
    : "Use an API key instead";
}

export function OnboardingProviderStep({
  providers,
  connectedBackendIds,
  onConnect,
  onCheckConnection,
  onStartBrowserLogin,
  onReady,
}: OnboardingProviderStepProps) {
  const families = useMemo(() => buildProviderFamilies(providers), [providers]);
  const visibleFamilies = useMemo(() => {
    const visible = ONBOARDING_PROVIDER_FAMILY_IDS.flatMap((id) => {
      const family = families.find((candidate) => candidate.id === id);
      return family ? [family] : [];
    });
    return visible.length > 0
      ? visible
      : families.filter((family) => family.id !== "custom").slice(0, 4);
  }, [families]);
  const [selectedFamilyId, setSelectedFamilyId] = useState<string>(
    () => visibleFamilies[0]?.id ?? "",
  );
  const [showCredential, setShowCredential] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{
    message: string;
    danger: boolean;
  } | null>(null);

  const selectedFamily =
    families.find((family) => family.id === selectedFamilyId) ??
    visibleFamilies[0];
  const customFamily = families.find((family) => family.id === "custom");
  const subscriptionMethod = selectedFamily?.methods.find(
    (method) =>
      method.kind === "oauth-browser" || method.kind === "provider-cli",
  );
  const credentialMethod = selectedFamily?.methods.find(
    (method) => method.kind === "api-key" || method.kind === "custom",
  );
  const subscriptionAvailable = Boolean(
    subscriptionMethod &&
    (subscriptionMethod.kind === "provider-cli"
      ? onCheckConnection
      : onStartBrowserLogin) &&
    subscriptionMethod.provider.authState !== "unsupported" &&
    subscriptionMethod.provider.authState !== "unavailable",
  );

  useEffect(() => {
    if (!families.some((family) => family.id === selectedFamilyId)) {
      setSelectedFamilyId(visibleFamilies[0]?.id ?? "");
    }
  }, [families, selectedFamilyId, visibleFamilies]);

  useEffect(() => {
    setShowCredential(!subscriptionAvailable);
    setFeedback(null);
  }, [selectedFamilyId, subscriptionAvailable]);

  if (!selectedFamily) {
    return (
      <p className="og-feedback og-feedback--danger" role="alert">
        No model providers are available in this build.
      </p>
    );
  }

  const completeResult = (result: BackendVerifyResult | void) => {
    if (!result) return;
    const copy = connectResultCopy(result.outcome, { detail: result.message });
    setFeedback({ message: copy.message, danger: copy.tone === "danger" });
    if (result.outcome === "ready" || result.outcome === "configured")
      onReady();
  };

  const runSubscription = async (method: ProviderConnectionMethod) => {
    setPending(true);
    setFeedback(null);
    try {
      const result =
        method.kind === "provider-cli" && onCheckConnection
          ? await onCheckConnection(method.provider.id)
          : await onStartBrowserLogin?.(method.provider.id);
      completeResult(result);
    } catch (error) {
      setFeedback({
        message:
          error instanceof Error
            ? error.message
            : "This connection could not be completed.",
        danger: true,
      });
    } finally {
      setPending(false);
    }
  };

  const runCredential = async (
    method: ProviderConnectionMethod,
    secret: string,
  ) => {
    setPending(true);
    setFeedback(null);
    try {
      completeResult(await onConnect(method.provider.id, secret));
    } catch (error) {
      setFeedback({
        message:
          error instanceof Error
            ? error.message
            : "This connection could not be completed.",
        danger: true,
      });
    } finally {
      setPending(false);
    }
  };

  const alreadyConnected = connectedFamily(selectedFamily, connectedBackendIds);
  const primaryLabel =
    selectedFamily.id === "antigravity"
      ? "Continue with Google"
      : subscriptionMethod?.provider.authState === "install-required"
        ? `Set up ${selectedFamily.label}`
        : selectedFamily.id === "openai"
          ? "Continue with ChatGPT"
          : `Continue with ${selectedFamily.label}`;

  return (
    <>
      <div className="og-icon-choices" aria-label="Model providers">
        {visibleFamilies.map((family) => {
          const selected = family.id === selectedFamily.id;
          const connected = connectedFamily(family, connectedBackendIds);
          return (
            <button
              key={family.id}
              type="button"
              className={`og-icon-choice${selected ? " is-selected" : ""}${connected ? " is-connected" : ""}`}
              aria-label={providerButtonLabel(family)}
              aria-pressed={selected}
              title={providerButtonLabel(family)}
              onClick={() => setSelectedFamilyId(family.id)}
            >
              <ProviderIcon provider={family.iconProvider} size={34} />
              {connected ? (
                <span className="og-icon-choice__check" aria-hidden="true">
                  ✓
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {customFamily ? (
        <button
          type="button"
          className="og-provider-alternative"
          aria-pressed={selectedFamily.id === customFamily.id}
          onClick={() => setSelectedFamilyId(customFamily.id)}
        >
          Or add a different API key
        </button>
      ) : null}

      <div className="og-provider-action">
        {alreadyConnected ? (
          <button type="button" className="og-primary-button" onClick={onReady}>
            Continue with {selectedFamily.label}
          </button>
        ) : subscriptionAvailable && subscriptionMethod && !showCredential ? (
          <>
            <button
              type="button"
              className="og-primary-button"
              disabled={pending}
              onClick={() => void runSubscription(subscriptionMethod)}
            >
              {pending ? (
                <>
                  <Spinner size={16} className="og-spinner" /> Connecting
                </>
              ) : (
                primaryLabel
              )}
            </button>
            {credentialMethod ? (
              <button
                type="button"
                className="og-text-button"
                disabled={pending}
                onClick={() => {
                  setShowCredential(true);
                  setFeedback(null);
                }}
              >
                {credentialLinkLabel(selectedFamily)}
              </button>
            ) : null}
          </>
        ) : credentialMethod ? (
          <CredentialForm
            key={credentialMethod.id}
            family={selectedFamily}
            method={credentialMethod}
            pending={pending}
            canReturn={subscriptionAvailable}
            onReturn={() => {
              setShowCredential(false);
              setFeedback(null);
            }}
            onSubmit={runCredential}
          />
        ) : (
          <p className="og-feedback og-feedback--danger" role="alert">
            {selectedFamily.label} does not offer a supported connection in this
            build.
          </p>
        )}
        {feedback ? (
          <p
            className={`og-feedback${feedback.danger ? " og-feedback--danger" : ""}`}
            role={feedback.danger ? "alert" : "status"}
          >
            {feedback.message}
          </p>
        ) : null}
      </div>
    </>
  );
}

function CredentialForm({
  family,
  method,
  pending,
  canReturn,
  onReturn,
  onSubmit,
}: {
  family: ProviderFamily;
  method: ProviderConnectionMethod;
  pending: boolean;
  canReturn: boolean;
  onReturn: () => void;
  onSubmit: (method: ProviderConnectionMethod, secret: string) => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelId, setModelId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const custom = method.kind === "custom";

  return (
    <form
      className="og-provider-form"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const secret = custom
            ? encodeCustomProviderSecret(
                baseUrl.trim(),
                apiKey.trim(),
                modelId.trim(),
              )
            : apiKey.trim();
          if (!custom && !secret)
            throw new Error(`Enter your ${method.provider.label} API key.`);
          setFormError(null);
          void onSubmit(method, secret).finally(() => setApiKey(""));
        } catch (error) {
          setFormError(
            error instanceof Error
              ? error.message
              : "Check these connection details.",
          );
        }
      }}
    >
      {custom ? (
        <>
          <label>
            <span>Base URL</span>
            <input
              type="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1"
              disabled={pending}
              autoFocus
            />
          </label>
          <label>
            <span>Model ID</span>
            <input
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              placeholder="model-name"
              disabled={pending}
            />
          </label>
        </>
      ) : null}
      <label>
        <span>{custom ? "API key (optional)" : `${family.label} API key`}</span>
        <input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={custom ? "Optional" : "Paste API key"}
          autoComplete="off"
          spellCheck={false}
          disabled={pending}
          autoFocus={!custom}
        />
      </label>
      {formError ? (
        <p className="og-feedback og-feedback--danger" role="alert">
          {formError}
        </p>
      ) : null}
      <button type="submit" className="og-primary-button" disabled={pending}>
        {pending ? (
          <>
            <Spinner size={16} className="og-spinner" /> Verifying
          </>
        ) : custom ? (
          "Connect provider"
        ) : (
          "Connect with API key"
        )}
      </button>
      {canReturn ? (
        <button
          type="button"
          className="og-text-button"
          disabled={pending}
          onClick={onReturn}
        >
          Use subscription instead
        </button>
      ) : null}
    </form>
  );
}

import {
  getRuntimeAdapter,
  hasNativeRuntimeAdapter,
} from "../../runtime/adapters/select";
import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { Browser } from "@phosphor-icons/react/dist/csr/Browser";
import { CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { Globe } from "@phosphor-icons/react/dist/csr/Globe";
import { Key } from "@phosphor-icons/react/dist/csr/Key";
import { Spinner } from "@phosphor-icons/react/dist/csr/Spinner";
import { TerminalWindow } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { Eye } from "@phosphor-icons/react/dist/csr/Eye";
import { EyeSlash } from "@phosphor-icons/react/dist/csr/EyeSlash";
import { LockKey } from "@phosphor-icons/react/dist/csr/LockKey";
import type { BackendVerifyResult } from "@mivlet/protocol";
import { ProviderIcon } from "../ProviderIcon";
import {
  additionalNativeProviderCatalog,
  providerEndpointSetup,
} from "@mivlet/connectors/backends/additional-native";
import {
  encodeCustomProviderSecret,
  isProviderConnected,
} from "./provider-catalogue-data";
import type {
  ProviderConnectionMethodKind,
  ProviderFamily,
} from "./provider-catalogue-data";
import { useProviderConnection } from "./useProviderConnection";
function ProviderMethodIcon({ kind }: { kind: ProviderConnectionMethodKind }) {
  switch (kind) {
    case "api-key":
      return <Key size={20} />;
    case "oauth-browser":
      return <Browser size={20} />;
    case "provider-cli":
      return <TerminalWindow size={20} />;
    case "custom":
      return <Globe size={20} />;
    default:
      return <Key size={20} />;
  }
}

export function ProviderConnectionFlow({
  onboarding,
  family,
  connectedBackendIds,
  onClose,
  onConnect,
  onDisconnect,
  onRefreshModels,
  onCheckConnection,
  onStartBrowserLogin,
  onStatus,
}: {
  onboarding: boolean;
  family: ProviderFamily;
  connectedBackendIds: string[];
  onClose: () => void;
  onConnect: (
    providerId: string,
    secret: string,
  ) => Promise<BackendVerifyResult>;
  onDisconnect?: (providerId: string) => void | Promise<void>;
  onRefreshModels?: (providerId: string) => void | Promise<void>;
  onCheckConnection?: (
    providerId: string,
  ) => BackendVerifyResult | void | Promise<BackendVerifyResult | void>;
  onStartBrowserLogin?: (providerId: string) => Promise<BackendVerifyResult>;
  onStatus?: (message: string) => void;
}) {
  const {
    selectedMethodId, setSelectedMethodId,
    pending, setPending,
    replacingCredential, setReplacingCredential,
    confirmingRemoval, setConfirmingRemoval,
    feedback, setFeedback,
    showKey, setShowKey,
    closeRef, keyInputRef, customBaseUrlRef, customModelRef, customKeyRef, providerEndpointRef,
    selectedMethod, methodVerifiedHere, methodConnected, methodConnectionLabel, methodState,
    connect, checkConnection, startBrowserLogin, goBack,
    setLocallyReady, setLocallyConfigured, setLocallyRemoved,
  } = useProviderConnection({
    family,
    connectedBackendIds,
    onClose,
    onConnect,
    onCheckConnection,
    onStartBrowserLogin,
    onStatus,
  });

  return (
    <section
      className="provider-connection-flow"
      role="region"
      aria-label={family.label}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          goBack();
        }
      }}
    >
      <article className="provider-connection-flow__panel">
        <button
          ref={closeRef}
          type="button"
          className="provider-method-detail__back"
          onClick={goBack}
          aria-label={
            selectedMethod && !pending
              ? "Back to connection methods"
              : "Back to providers"
          }
        >
          <ArrowLeft size={18} />{" "}
          {selectedMethod && !pending ? family.label : "Providers"}
        </button>
        {pending && (
          <p role="status">You can go back while this connection finishes.</p>
        )}
        <header className="provider-connection-flow__header">
          <span className="provider-connection-flow__logo" aria-hidden="true">
            <ProviderIcon
              provider={family.iconProvider}
              size={onboarding ? 72 : 38}
            />
          </span>
          <h2>
            {selectedMethod?.kind === "api-key" && !methodConnected
              ? "Connect with an API key"
              : `Connect ${family.label}`}
          </h2>
          {(!onboarding || selectedMethod) && (
            <p>
              {selectedMethod
                ? selectedMethod.kind === "api-key"
                  ? `Add a key from your ${selectedMethod.provider.id === "openai" ? "OpenAI" : selectedMethod.provider.label} developer account.`
                  : selectedMethod.label
                : "Choose how you’d like to connect."}
            </p>
          )}
          {selectedMethod?.kind === "api-key" && family.id === "openai" ? (
            <small>API usage is billed separately from ChatGPT.</small>
          ) : null}
        </header>

        {selectedMethod ? (
          <div className="provider-method-detail">
            {methodConnected || selectedMethod.kind !== "api-key" ? (
              <div className="provider-method-detail__heading">
                <span aria-hidden="true">
                  <ProviderMethodIcon kind={selectedMethod.kind} />
                </span>
                <div>
                  <strong>{selectedMethod.label}</strong>
                  <p>{selectedMethod.description}</p>
                </div>
                <small
                  data-tone={
                    methodConnected
                      ? selectedMethod.provider.backendType === "native-api" &&
                        !methodVerifiedHere
                        ? "info"
                        : "ready"
                      : methodState?.tone
                  }
                >
                  {methodConnected ? methodConnectionLabel : methodState?.label}
                </small>
              </div>
            ) : null}

            {selectedMethod.provider.backendType === "native-api" &&
            selectedMethod.provider.authState === "unavailable" &&
            !methodConnected ? (
              <div className="provider-method-detail__instructions">
                <div>
                  <p role="status">
                    {selectedMethod.provider.installHint ??
                      "Check your network, then retry the saved connection."}
                  </p>
                  {onCheckConnection ? (
                    <button
                      type="button"
                      className="provider-method-detail__check"
                      disabled={pending}
                      onClick={() =>
                        void checkConnection(selectedMethod.provider.id)
                      }
                    >
                      {pending ? "Checking…" : "Check connection"}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {selectedMethod.kind === "api-key" &&
            (!methodConnected || replacingCredential) ? (
              <form
                className="provider-method-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const secret = keyInputRef.current?.value.trim() ?? "";
                  if (!secret) {
                    setFeedback({
                      message: "Enter an API key to connect.",
                      tone: "danger",
                    });
                    return;
                  }
                  const endpoint = providerEndpointSetup(
                    selectedMethod.provider.id,
                  );
                  const credential = endpoint
                    ? JSON.stringify({
                        version: 1,
                        baseUrl:
                          providerEndpointRef.current?.value.trim() ?? "",
                        apiKey: secret,
                      })
                    : secret;
                  void connect(selectedMethod.provider.id, credential, () => {
                    if (keyInputRef.current) keyInputRef.current.value = "";
                  });
                }}
              >
                <label>
                  <span>
                    {selectedMethod.provider.id === "openai"
                      ? "OpenAI"
                      : selectedMethod.provider.label}{" "}
                    API key
                  </span>
                  <span className="provider-key-input">
                    <input
                      ref={keyInputRef}
                      type={showKey ? "text" : "password"}
                      aria-label={`API key for ${family.label.toLowerCase()}`}
                      placeholder="Paste your API key"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={pending}
                    />
                    <button
                      type="button"
                      aria-label={showKey ? "Hide API key" : "Show API key"}
                      aria-pressed={showKey}
                      onClick={() => setShowKey(!showKey)}
                    >
                      {showKey ? <EyeSlash size={20} /> : <Eye size={20} />}
                    </button>
                  </span>
                </label>
                {family.id === "openai" ? (
                  <a
                    className="provider-key-help"
                    href="https://platform.openai.com/api-keys"
                    onClick={(event) => {
                      if (!hasNativeRuntimeAdapter()) return;
                      event.preventDefault();
                      void getRuntimeAdapter()
                        .invoke<void>("open_conversation_link", {
                          url: "https://platform.openai.com/api-keys",
                        })
                        .catch(() =>
                          setFeedback({
                            message:
                              "Browser unavailable. Create a key at platform.openai.com/api-keys.",
                            tone: "danger",
                          }),
                        );
                    }}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Get an API key ↗
                  </a>
                ) : null}
                <p className="provider-security-note">
                  <LockKey size={18} aria-hidden="true" />
                  Stored securely on this device.
                </p>
                {providerEndpointSetup(selectedMethod.provider.id) ? (
                  <label>
                    <span>Model Studio endpoint</span>
                    <input
                      ref={providerEndpointRef}
                      type="url"
                      aria-label="Alibaba Model Studio endpoint"
                      defaultValue={
                        providerEndpointSetup(selectedMethod.provider.id)
                          ?.defaultValue
                      }
                      placeholder={
                        providerEndpointSetup(selectedMethod.provider.id)
                          ?.placeholder
                      }
                      autoComplete="off"
                      spellCheck={false}
                      required
                      disabled={pending}
                    />
                    <small>
                      {
                        providerEndpointSetup(selectedMethod.provider.id)
                          ?.description
                      }
                    </small>
                  </label>
                ) : null}
                {additionalNativeProviderCatalog.some(
                  (entry) => entry.providerId === selectedMethod.provider.id,
                ) ? (
                  <small>
                    Connecting sends a short model request to verify access,
                    with a limit of 16 output tokens.
                  </small>
                ) : null}
                <div className="provider-method-form__actions">
                  <button
                    type="submit"
                    className="provider-method-form__primary"
                    disabled={pending}
                  >
                    {pending ? (
                      <>
                        <Spinner size={14} className="og-spinner" /> Verifying
                      </>
                    ) : replacingCredential ? (
                      "Replace key & reconnect"
                    ) : (
                      "Connect"
                    )}
                  </button>
                  <button
                    type="button"
                    className="provider-method-cancel"
                    disabled={pending}
                    onClick={() => {
                      setSelectedMethodId(null);
                      setReplacingCredential(false);
                      setFeedback(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : null}

            {selectedMethod.kind === "custom" && !methodConnected ? (
              <form
                className="provider-method-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const baseUrl = customBaseUrlRef.current?.value.trim() ?? "";
                  const modelId = customModelRef.current?.value.trim() ?? "";
                  const apiKey = customKeyRef.current?.value.trim() ?? "";
                  if (!baseUrl) {
                    setFeedback({
                      message: "Enter the provider's base URL.",
                      tone: "danger",
                    });
                    return;
                  }
                  if (!modelId) {
                    setFeedback({
                      message: "Enter the model ID used by this endpoint.",
                      tone: "danger",
                    });
                    return;
                  }
                  try {
                    const secret = encodeCustomProviderSecret(
                      baseUrl,
                      apiKey,
                      modelId,
                    );
                    void connect(selectedMethod.provider.id, secret, () => {
                      if (customKeyRef.current) customKeyRef.current.value = "";
                    });
                  } catch (error) {
                    setFeedback({
                      message:
                        error instanceof Error
                          ? error.message
                          : "Enter a valid base URL.",
                      tone: "danger",
                    });
                  }
                }}
              >
                <label>
                  <span>Base URL</span>
                  <input
                    ref={customBaseUrlRef}
                    type="url"
                    aria-label="Custom provider base URL"
                    placeholder="https://api.example.com/v1"
                    autoComplete="url"
                    disabled={pending}
                  />
                </label>
                <label>
                  <span>Model ID</span>
                  <input
                    ref={customModelRef}
                    type="text"
                    aria-label="Custom provider model ID"
                    placeholder="model-name"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={pending}
                  />
                </label>
                <label>
                  <span>
                    API key <small>Optional</small>
                  </span>
                  <input
                    ref={customKeyRef}
                    type="password"
                    aria-label="API key for custom provider"
                    placeholder="Enter a key if required"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={pending}
                  />
                </label>
                <button
                  type="submit"
                  className="provider-method-form__primary"
                  disabled={pending}
                >
                  {pending ? (
                    <>
                      <Spinner size={14} className="og-spinner" /> Connecting
                    </>
                  ) : (
                    "Connect endpoint"
                  )}
                </button>
              </form>
            ) : null}

            {selectedMethod.kind === "oauth-browser" ||
            selectedMethod.kind === "provider-cli" ? (
              <div className="provider-method-detail__instructions">
                {selectedMethod.kind === "oauth-browser" ? (
                  <Browser size={19} aria-hidden="true" />
                ) : (
                  <TerminalWindow size={19} aria-hidden="true" />
                )}
                <div>
                  <strong>
                    {selectedMethod.kind === "oauth-browser"
                      ? "Provider-supported browser sign-in"
                      : "Provider-owned local sign-in"}
                  </strong>
                  <p>
                    {selectedMethod.kind === "oauth-browser"
                      ? "Mivlet opens the provider's official page and waits for sign-in."
                      : "Mivlet reads only connection state from the provider's official local runtime."}{" "}
                    Credentials never enter the Mivlet interface.
                  </p>
                  <p>
                    {selectedMethod.provider.installHint ??
                      "Only runtime connection state is read; subscription tokens are never collected."}
                  </p>
                </div>
              </div>
            ) : null}

            {(selectedMethod.kind === "provider-cli" ||
              (selectedMethod.kind === "oauth-browser" &&
                selectedMethod.provider.id !== "antigravity")) &&
            selectedMethod.provider.authState === "install-required" &&
            onCheckConnection &&
            !methodConnected ? (
              <button
                type="button"
                className="provider-method-detail__check"
                disabled={pending}
                onClick={() => void checkConnection(selectedMethod.provider.id)}
              >
                {pending ? (
                  <>
                    <Spinner size={14} className="og-spinner" /> Checking
                  </>
                ) : (
                  `Check for ${selectedMethod.provider.label}`
                )}
              </button>
            ) : null}

            {selectedMethod.kind === "provider-cli" &&
            selectedMethod.provider.authState !== "install-required" &&
            selectedMethod.provider.authState !== "unavailable" &&
            onCheckConnection &&
            !methodConnected ? (
              <button
                type="button"
                className="provider-method-form__primary"
                disabled={pending}
                onClick={() => void checkConnection(selectedMethod.provider.id)}
              >
                {pending ? (
                  <>
                    <Spinner size={14} className="og-spinner" /> Checking
                  </>
                ) : (
                  "Check connection"
                )}
              </button>
            ) : null}

            {selectedMethod.kind === "oauth-browser" &&
            (selectedMethod.provider.authState !== "install-required" ||
              selectedMethod.provider.id === "antigravity") &&
            onStartBrowserLogin &&
            !methodConnected ? (
              <button
                type="button"
                className="provider-method-form__primary"
                disabled={pending}
                onClick={() =>
                  void startBrowserLogin(selectedMethod.provider.id)
                }
              >
                {pending ? (
                  <>
                    <Spinner size={14} className="og-spinner" /> Waiting for
                    browser
                  </>
                ) : selectedMethod.provider.id === "antigravity" ? (
                  "Continue with Google"
                ) : (
                  "Continue in browser"
                )}
              </button>
            ) : null}

            {methodConnected ? (
              <div className="provider-method-detail__connected">
                <CheckCircle size={18} weight="fill" aria-hidden="true" />
                <span>
                  {selectedMethod.provider.backendType === "native-api" &&
                  !methodVerifiedHere
                    ? "Configured. A live model request is the final check."
                    : "This connection is ready."}
                </span>
                <div>
                  {onCheckConnection ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        void checkConnection(selectedMethod.provider.id)
                      }
                    >
                      {pending ? "Checking…" : "Check health"}
                    </button>
                  ) : null}
                  {onRefreshModels &&
                  selectedMethod.provider.capabilities.includes(
                    "model-availability",
                  ) ? (
                    <button
                      type="button"
                      onClick={() =>
                        void onRefreshModels(selectedMethod.provider.id)
                      }
                    >
                      Refresh models
                    </button>
                  ) : null}
                  {onDisconnect &&
                  selectedMethod.provider.backendType === "native-api" ? (
                    <button
                      type="button"
                      onClick={() => setReplacingCredential(true)}
                    >
                      Replace key
                    </button>
                  ) : null}
                  {onDisconnect && selectedMethod.provider.id !== "codex" ? (
                    <button
                      type="button"
                      onClick={() => setConfirmingRemoval(true)}
                    >
                      Remove from Mivlet
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {confirmingRemoval && selectedMethod.provider.id !== "codex" ? (
              <div
                className="provider-method-detail__removal"
                role="alertdialog"
                aria-label={`Remove ${selectedMethod.provider.label} from Mivlet`}
              >
                <strong>
                  {selectedMethod.provider.backendType === "native-api"
                    ? "Remove this key from Mivlet?"
                    : "Disconnect this provider?"}
                </strong>
                <p>
                  {selectedMethod.provider.backendType === "native-api"
                    ? "Deletes Mivlet's local key. This does not revoke the key at the provider; revoke it there if it may be compromised."
                    : "Removes this account's local Antigravity profile and Google session."}
                </p>
                <div>
                  <button
                    type="button"
                    onClick={() => setConfirmingRemoval(false)}
                  >
                    Keep provider
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setPending(true);
                      void Promise.resolve(
                        onDisconnect?.(selectedMethod.provider.id),
                      )
                        .then(() => {
                          setLocallyReady(null);
                          setLocallyConfigured(null);
                          setLocallyRemoved(selectedMethod.provider.id);
                          setReplacingCredential(false);
                          setConfirmingRemoval(false);
                          const message =
                            "Removed from Mivlet. Revoke the key at the provider too if needed.";
                          setFeedback({ message, tone: "neutral" });
                          onStatus?.(message);
                        })
                        .catch((error) => {
                          const message =
                            error instanceof Error
                              ? error.message
                              : "Could not remove this provider.";
                          setFeedback({ message, tone: "danger" });
                        })
                        .finally(() => setPending(false));
                    }}
                  >
                    {selectedMethod.provider.backendType === "native-api"
                      ? "Remove key"
                      : "Disconnect"}
                  </button>
                </div>
              </div>
            ) : null}

            {feedback ? (
              <p
                className="provider-method-detail__feedback"
                data-tone={feedback.tone}
                role={feedback.tone === "danger" ? "alert" : "status"}
              >
                {feedback.message}
              </p>
            ) : null}
          </div>
        ) : (
          <div
            className="provider-connection-methods"
            aria-label={`Connection methods for ${family.label}`}
          >
            {family.methods.map((method) => {
              const connected = isProviderConnected(
                method.provider,
                connectedBackendIds,
              );
              const state = connected
                ? method.provider.backendType === "native-api"
                  ? { label: "Configured", tone: "info" }
                  : { label: "Connected", tone: "ready" }
                : stateViewFor(method.provider.authState);
              return (
                <button
                  key={method.id}
                  type="button"
                  className="provider-connection-method"
                  onClick={() => {
                    setSelectedMethodId(method.id);
                    setFeedback(null);
                    if (
                      onboarding &&
                      method.kind === "oauth-browser" &&
                      onStartBrowserLogin &&
                      (method.provider.authState !== "install-required" ||
                        method.provider.id === "antigravity") &&
                      !connected
                    ) {
                      void startBrowserLogin(method.provider.id);
                    }
                  }}
                >
                  <span
                    className="provider-connection-method__icon"
                    aria-hidden="true"
                  >
                    <ProviderMethodIcon kind={method.kind} />
                  </span>
                  <span>
                    <strong>
                      {method.kind === "api-key"
                        ? "Use an API key"
                        : method.provider.id === "codex"
                          ? "Sign in with ChatGPT"
                          : method.label}
                    </strong>
                    {!onboarding && (
                      <small>
                        {method.provider.id === "codex"
                          ? "Continue with your ChatGPT account in your browser."
                          : method.description}
                      </small>
                    )}
                  </span>
                  {connected ||
                  ["install-required", "unavailable"].includes(
                    method.provider.authState,
                  ) ? (
                    <span
                      className="provider-connection-method__state"
                      data-tone={state.tone}
                    >
                      {state.label}
                    </span>
                  ) : (
                    <span />
                  )}
                  <CaretRight size={16} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        )}
        {onboarding && !selectedMethod && family.id === "openai" && (
          <p className="provider-onboarding-billing">
            API usage is billed separately.
          </p>
        )}
      </article>
    </section>
  );
}

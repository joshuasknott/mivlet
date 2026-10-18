import { useLayoutEffect, useRef, useState } from "react";
import type { BackendVerifyResult } from "@mivlet/protocol";
import { connectResultCopy, stateViewFor } from "../../lib/backend-state";
import { isProviderConnected } from "./provider-catalogue-data";
import type { ProviderFamily } from "./provider-catalogue-data";

export interface ProviderConnectionActionsProps {
  family: ProviderFamily;
  connectedBackendIds: string[];
  onClose: () => void;
  onConnect: (providerId: string, secret: string) => Promise<BackendVerifyResult>;
  onCheckConnection?: (providerId: string) => BackendVerifyResult | void | Promise<BackendVerifyResult | void>;
  onStartBrowserLogin?: (providerId: string) => Promise<BackendVerifyResult>;
  onStatus?: (message: string) => void;
}

export function useProviderConnection({
  family,
  connectedBackendIds,
  onClose,
  onConnect,
  onCheckConnection,
  onStartBrowserLogin,
  onStatus,
}: ProviderConnectionActionsProps) {
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [locallyReady, setLocallyReady] = useState<string | null>(null);
  const [locallyConfigured, setLocallyConfigured] = useState<string | null>(
    null,
  );
  const [locallyRemoved, setLocallyRemoved] = useState<string | null>(null);
  const [replacingCredential, setReplacingCredential] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [feedback, setFeedback] = useState<{
    message: string;
    tone: string;
  } | null>(null);
  const [showKey, setShowKey] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const keyInputRef = useRef<HTMLInputElement>(null);
  const customBaseUrlRef = useRef<HTMLInputElement>(null);
  const customModelRef = useRef<HTMLInputElement>(null);
  const customKeyRef = useRef<HTMLInputElement>(null);
  const providerEndpointRef = useRef<HTMLInputElement>(null);
  const selectedMethod = family.methods.find(
    (method) => method.id === selectedMethodId,
  );

  useLayoutEffect(() => {
    closeRef.current?.focus();
  }, []);
  useLayoutEffect(() => {
    closeRef.current?.focus();
    setShowKey(false);
  }, [selectedMethodId]);

  const connect = async (
    providerId: string,
    secret: string,
    clearSecret?: () => void,
  ) => {
    setPending(true);
    setFeedback(null);
    try {
      const result = await onConnect(providerId, secret);
      const copy = connectResultCopy(result.outcome, {
        detail: result.message,
      });
      setFeedback({ message: copy.message, tone: copy.tone });
      onStatus?.(copy.message);
      if (result.outcome === "ready") {
        setLocallyReady(providerId);
        setLocallyConfigured(null);
        setLocallyRemoved(null);
        setReplacingCredential(false);
      } else if (result.outcome === "configured") {
        setLocallyConfigured(providerId);
        setLocallyReady(null);
        setLocallyRemoved(null);
        setReplacingCredential(false);
      }
      return result;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not connect this provider.";
      setFeedback({ message, tone: "danger" });
      onStatus?.(message);
      return null;
    } finally {
      clearSecret?.();
      setPending(false);
    }
  };

  const methodVerifiedHere = selectedMethod
    ? locallyReady === selectedMethod.provider.id
    : false;
  const methodConfiguredHere = selectedMethod
    ? locallyConfigured === selectedMethod.provider.id
    : false;
  const methodConnected = selectedMethod
    ? locallyRemoved === selectedMethod.provider.id
      ? false
      : methodVerifiedHere ||
        methodConfiguredHere ||
        isProviderConnected(selectedMethod.provider, connectedBackendIds)
    : false;
  const methodConnectionLabel = methodVerifiedHere
    ? "Ready"
    : selectedMethod?.provider.backendType === "native-api"
      ? "Configured"
      : "Connected";
  const methodState = selectedMethod
    ? stateViewFor(selectedMethod.provider.authState)
    : null;

  const checkConnection = async (providerId: string) => {
    if (!onCheckConnection) return;
    setPending(true);
    setFeedback(null);
    try {
      const result = await onCheckConnection(providerId);
      if (result?.outcome === "ready") {
        setLocallyReady(providerId);
        setLocallyConfigured(null);
        setLocallyRemoved(null);
      } else if (result?.outcome === "configured") {
        setLocallyConfigured(providerId);
        setLocallyReady(null);
        setLocallyRemoved(null);
      } else if (result?.outcome === "auth-failed") {
        setLocallyReady(null);
        setLocallyConfigured(null);
        setLocallyRemoved(providerId);
      }
      const copy = result
        ? connectResultCopy(result.outcome, { detail: result.message })
        : { message: "Connection state refreshed.", tone: "neutral" };
      const message = copy.message;
      setFeedback({ message, tone: copy.tone });
      onStatus?.(message);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not refresh this connection.";
      setFeedback({ message, tone: "danger" });
      onStatus?.(message);
    } finally {
      setPending(false);
    }
  };

  const startBrowserLogin = async (providerId: string) => {
    if (!onStartBrowserLogin) return;
    setPending(true);
    setFeedback(null);
    try {
      const result = await onStartBrowserLogin(providerId);
      if (result.outcome === "ready") {
        setLocallyReady(providerId);
        setLocallyConfigured(null);
        setLocallyRemoved(null);
      }
      const copy = connectResultCopy(result.outcome, {
        detail: result.message,
      });
      setFeedback({ message: copy.message, tone: copy.tone });
      onStatus?.(copy.message);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Browser sign-in could not be completed.";
      setFeedback({ message, tone: "danger" });
      onStatus?.(message);
    } finally {
      setPending(false);
    }
  };

  const goBack = () => {
    if (pending) {
      onClose();
      return;
    }
    if (selectedMethodId) {
      setSelectedMethodId(null);
      setReplacingCredential(false);
      setConfirmingRemoval(false);
      setFeedback(null);
    } else onClose();
  };
  return {
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
  };
}

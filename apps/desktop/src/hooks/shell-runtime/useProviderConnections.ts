import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  type RefObject,
} from "react";
import type {
  BackendProvider,
  BackendVerifyOutcome,
  BackendVerifyResult,
} from "@mivlet/protocol";
import {
  hasRunnableAdapter,
  listBackendProviders,
  mergeDiscoveredModels,
  resolveCapabilities,
  type ModelDiscoveryResult,
} from "@mivlet/connectors";
import {
  modelsForProvider,
  providerModelOptions,
  resolveProviderModelOption,
} from "../../lib/provider-models";
import {
  clearRuntimeBackend,
  connectRuntimeBackend,
  checkRuntimeAntigravityConnection,
  checkRuntimeManagedConnection,
  installRuntimeAntigravity,
  logoutRuntimeAntigravity,
  logoutRuntimeManaged,
  startRuntimeAntigravityBrowserLogin,
  startRuntimeCodexBrowserLogin,
  startRuntimeManagedLogin,
  type ManagedRuntimeProviderId,
} from "../../runtime/domains/providers";
import { type PersistedShellState } from "../../lib/types";
import { hasTauriRuntime } from "../../lib/persistence";
import type { ModelDiscoveryOutcome } from "../../lib/backend-state";
import {
  enabledMivletProviders,
  isMivletProviderEnabled,
} from "../../lib/provider-availability";

import { createProviderConnectionRequests } from "./provider-connection-requests";

function initialProviders(connectedIds: string[]): BackendProvider[] {
  return enabledMivletProviders(listBackendProviders()).map((provider) => {
    if (hasTauriRuntime() || provider.backendType !== "native-api" ||
        !connectedIds.includes(provider.id)) return provider;
    return {
      ...provider,
      authState: "connected",
      capabilities: resolveCapabilities(provider.backendType, "connected", true),
      models: provider.models.map((model) => ({ ...model, available: true })),
    };
  });
}

/** Provider setup, verification, discovery and model selection for one shell. */
export function useProviderConnections({
  initialState,
  workspaceScopeGeneration,
  workspaceIdentityRef,
  selectedModelId,
  hiddenModelIds,
  setLastAction,
}: {
  initialState: PersistedShellState;
  workspaceScopeGeneration: number;
  workspaceIdentityRef: RefObject<string | null>;
  selectedModelId: string;
  hiddenModelIds: string[];
  setLastAction: (message: string) => void;
}) {
  const initialStateRef = useRef(initialState);
  const [connectedBackendIds, setConnectedBackendIds] = useState<string[]>(
    hasTauriRuntime()
      ? []
      : initialState.connectedBackendIds.filter(isMivletProviderEnabled),
  );

  // Agent-runtime backends. The Rust credential boundary resolves auth state
  // + capabilities; outside Tauri the preview registry is used so the workspace
  // shell stays testable. Preview connections remain visibly synthetic, while
  // the same provider gate is enforced in preview and native builds.
  const [backendProviders, setBackendProviders] = useState<BackendProvider[]>(
    () => initialProviders(initialState.connectedBackendIds),
  );

  // Dynamically discovered model ids per native provider id, plus whether
  // discovery actually ran for that provider (so the catalogue fallback is
  // truthful: an omitted catalogue id is unavailable once discovery succeeded).
  const [discoveredModels, setDiscoveredModels] = useState<
    Record<string, ModelDiscoveryResult>
  >({});

  // Per-provider model-discovery lifecycle, surfaced to Settings so the row can
  // show a refresh spinner and recoverable-failure copy. `idle` = not yet run.
  const [modelDiscoveryByProvider, setModelDiscoveryByProvider] = useState<
    Record<string, ModelDiscoveryOutcome>
  >({});

  const [backendStatus, setBackendStatus] = useState<string | null>(null);

  const [providerScopeGeneration, setProviderScopeGeneration] = useState(
    workspaceScopeGeneration,
  );
  const scopeGenerationRef = useRef(workspaceScopeGeneration);
  scopeGenerationRef.current = workspaceScopeGeneration;
  const requests = useMemo(() => {
    const identity = workspaceIdentityRef.current;
    return createProviderConnectionRequests({
      isCurrent: () =>
        workspaceIdentityRef.current === identity &&
        scopeGenerationRef.current === workspaceScopeGeneration &&
        (!hasTauriRuntime() || identity !== null),
      onProviders: (providers) => {
        setBackendProviders(providers);
        const connected = new Set(
          providers
            .filter((provider) => provider.authState === "connected")
            .map((provider) => provider.id),
        );
        // A refreshed native catalogue can remove a connection without a UI
        // disconnect action. Drop its discovery lifecycle so reconnect can run
        // a fresh query rather than inherit a spinner or another credential's list.
        setDiscoveredModels((current) =>
          Object.fromEntries(
            Object.entries(current).filter(([id]) => connected.has(id)),
          ),
        );
        setModelDiscoveryByProvider((current) =>
          Object.fromEntries(
            Object.entries(current).filter(([id]) => connected.has(id)),
          ),
        );
        setConnectedBackendIds([...connected]);
      },
      onDiscovery: (providerId, result) => {
        setModelDiscoveryByProvider((current) => ({
          ...current,
          [providerId]: result?.outcome ?? "unsupported",
        }));
        if (!result) return;
        setDiscoveredModels((current) => ({
          ...current,
          [providerId]: result,
        }));
        if (result.outcome === "failed")
          setBackendStatus(
            result.message ??
              "Model discovery failed. Choose Refresh models to retry.",
          );
      },
    });
  }, [workspaceScopeGeneration, workspaceIdentityRef]);
  const scopedBackendProviders =
    providerScopeGeneration === workspaceScopeGeneration && requests.isCurrent()
      ? backendProviders
      : enabledMivletProviders(listBackendProviders());

  // Every runnable connection participates in the model picker. Selection owns
  // routing: Mivlet no longer silently sends all prompts to the first connection.
  const connectedAgentBackends = useMemo(
    () =>
      scopedBackendProviders.filter(
        (provider) =>
          provider.authState === "connected" &&
          provider.capabilities.includes("streaming") &&
          hasRunnableAdapter(
            provider.driverKind ??
              (provider.backendType === "codex-app-server"
                ? "codex"
                : provider.backendType),
          ) &&
          (provider.backendType === "native-api" || hasTauriRuntime()),
      ),
    [scopedBackendProviders],
  );

  const allModelOptions = useMemo(
    () =>
      providerModelOptions(
        connectedAgentBackends.map((provider) => {
          const discovery = discoveredModels[provider.id];
          const models = discovery
            ? mergeDiscoveredModels({
                providerId: provider.id,
                catalogueModels: provider.models,
                discovered: discovery.models,
                connected: true,
                discoveryRan:
                  discovery.outcome === "success" ||
                  discovery.outcome === "empty",
              })
            : provider.models;
          return { provider, models };
        }),
      ),
    [connectedAgentBackends, discoveredModels],
  );

  const modelOptions = useMemo(
    () => allModelOptions.filter((model) => !hiddenModelIds.includes(model.id)),
    [allModelOptions, hiddenModelIds],
  );

  const resolvedModelOption = useMemo(
    () => resolveProviderModelOption(modelOptions, selectedModelId),
    [modelOptions, selectedModelId],
  );

  const connectedAgentBackend = useMemo(
    () =>
      connectedAgentBackends.find(
        (provider) => provider.id === resolvedModelOption?.providerId,
      ) ?? connectedAgentBackends[0],
    [connectedAgentBackends, resolvedModelOption?.providerId],
  );

  const selectableModels = useMemo(
    () => modelsForProvider(modelOptions, connectedAgentBackend?.id),
    [modelOptions, connectedAgentBackend?.id],
  );

  const resolvedSelectedModelId = resolvedModelOption?.modelId ?? "";

  const resolvedModelOptionId = resolvedModelOption?.id ?? "";

  const refreshBackendProviders = useCallback(
    (checkedProviderId?: string) => requests.refresh(checkedProviderId),
    [requests],
  );

  useEffect(() => {
    requests.activate();
    setProviderScopeGeneration(workspaceScopeGeneration);
    setBackendProviders(initialProviders(initialStateRef.current.connectedBackendIds));
    setConnectedBackendIds(
      hasTauriRuntime()
        ? []
        : initialStateRef.current.connectedBackendIds.filter(
            isMivletProviderEnabled,
          ),
    );
    setDiscoveredModels({});
    setModelDiscoveryByProvider({});
    setBackendStatus(null);
    void refreshBackendProviders();
    return () => requests.dispose();
  }, [requests, refreshBackendProviders, workspaceScopeGeneration]);

  const runModelDiscovery = useCallback(
    (providerId: string): Promise<void> => {
      if (!requests.isCurrent()) return Promise.resolve();
      setModelDiscoveryByProvider((current) => ({
        ...current,
        [providerId]: "loading",
      }));
      return requests.discover(providerId);
    },
    [requests],
  );

  // Auto-run discovery for connected HTTP providers and Antigravity's cached
  // ACP account model list. Codex exposes its own catalogue directly.
  useEffect(() => {
    for (const provider of connectedAgentBackends) {
      if (
        (provider.backendType === "native-api" ||
          provider.backendType === "antigravity-acp") &&
        (modelDiscoveryByProvider[provider.id] ?? "idle") === "idle"
      ) {
        void runModelDiscovery(provider.id);
      }
    }
  }, [connectedAgentBackends, modelDiscoveryByProvider, runModelDiscovery]);

  /**
   * Manual model refresh for Settings. Re-runs discovery for a connected
   * provider and updates its lifecycle so the row can show loading then a fresh
   * result or a retryable failure. No-op when the provider isn't connected.
   */
  const refreshModels = useCallback(
    async (providerId: string): Promise<void> => {
      const provider = scopedBackendProviders.find(
        (entry) => entry.id === providerId,
      );
      if (!provider || provider.authState !== "connected") {
        return;
      }
      await runModelDiscovery(providerId);
    },
    [scopedBackendProviders, runModelDiscovery],
  );

  // Agent-runtime backend connect/disconnect. The secret is handed to the Rust
  // credential boundary; React only ever sees the resulting auth state. Outside
  // Tauri we record a local preview connection so the onboarding gate clears
  // and the UI stays testable.
  //
  // The verified path (`connectBackendWithVerify`) is the single connect entry
  // point for onboarding + Settings: store → mark connecting → verify against
  // the provider inside the boundary → reflect. `connectBackend` is retained as
  // a fire-and-forget wrapper over it for the legacy contract.
  const resetProviderDiscovery = (providerId: string) => {
    connectionChecks.delete(providerId);
    setDiscoveredModels((current) => {
      const next = { ...current };
      delete next[providerId];
      return next;
    });
    setModelDiscoveryByProvider((current) => {
      const next = { ...current };
      delete next[providerId];
      return next;
    });
  };
  const staleConnection = (providerId: string): BackendVerifyResult => ({
    providerId,
    outcome: "failed",
    message:
      "The account or provider connection changed. Check the current connection again.",
  });

  const markProviderState = (
    providerId: string,
    authState: BackendProvider["authState"],
  ) => {
    setBackendProviders((current) =>
      current.map((provider) =>
        provider.id === providerId
          ? {
              ...provider,
              authState,
              capabilities: resolveCapabilities(
                provider.backendType,
                authState,
                provider.backendType === "native-api",
              ),
              models: provider.models.map((model) => ({
                ...model,
                available: authState === "connected",
              })),
            }
          : provider,
      ),
    );
  };

  const connectBackendWithVerify = async (
    providerId: string,
    secret: string,
  ): Promise<BackendVerifyResult> => {
    if (!isMivletProviderEnabled(providerId)) {
      const message =
        "This provider is not available in the current Mivlet release.";
      setBackendStatus(message);
      return { providerId, outcome: "unsupported", message };
    }
    const token = requests.invalidate(providerId);
    if (!requests.isCurrent(token)) return staleConnection(providerId);
    resetProviderDiscovery(providerId);
    setBackendStatus(`Connecting ${providerId}…`);
    // Surface the connecting state on the provider card while the round-trip
    // is in flight. This is a transient UI state; the boundary re-resolves to
    // connected/needs-auth after verification.
    markProviderState(providerId, "connecting");
    try {
      const stored = await connectRuntimeBackend({ providerId, secret });
      if (!requests.isCurrent(token)) return staleConnection(providerId);
      requests.finishMutation(token);
      if (stored === null) {
        // Preview mode (no Tauri runtime): record a local connection only.
        // The secret is the placeholder preview value, never a real key, so no
        // credential is fabricated.
        setConnectedBackendIds((current) =>
          current.includes(providerId) ? current : [...current, providerId],
        );
        markProviderState(providerId, "connected");
        setBackendStatus(`${providerId} connected (preview).`);
        setLastAction(`${providerId} connected (preview)`);
        return { providerId, outcome: "ready" };
      }

      // Key stored in the keychain. Verify it against the provider inside the
      // Rust boundary — the secret never crosses back into JS.
      const result = await requests.verify(providerId);
      if (!requests.isCurrent(token)) return staleConnection(providerId);
      // A missing verification command must never turn key storage into proof
      // of a usable provider. Browser preview returned earlier above.
      if (!result) {
        await clearRuntimeBackend(providerId);
        if (!requests.isCurrent(token)) return staleConnection(providerId);
        await refreshBackendProviders(providerId);
        if (!requests.isCurrent(token)) return staleConnection(providerId);
        markProviderState(providerId, "needs-auth");
        const message =
          "Mivlet could not verify this provider in the desktop runtime. Update Mivlet and try again.";
        setBackendStatus(message);
        setLastAction(message);
        return { providerId, outcome: "failed", message };
      }
      const outcome: BackendVerifyOutcome = result.outcome;
      const message = result.message;

      if (outcome === "auth-failed") {
        // The provider rejected the key: clear it so the bad credential does
        // not linger as a "connected" provider, then surface a useful error.
        await clearRuntimeBackend(providerId);
        if (!requests.isCurrent(token)) return staleConnection(providerId);
        await refreshBackendProviders(providerId);
        if (!requests.isCurrent(token)) return staleConnection(providerId);
        markProviderState(providerId, "needs-auth");
        const status =
          message ??
          `${providerId} rejected this key. Check the key and try again.`;
        setBackendStatus(status);
        setLastAction(status);
        return { providerId, outcome, message: status };
      }

      if (outcome === "ready" || outcome === "configured") {
        await refreshBackendProviders(providerId);
        if (!requests.isCurrent(token)) return staleConnection(providerId);
        const status =
          message ??
          (outcome === "configured"
            ? `${providerId} configured. The endpoint will be checked when first used.`
            : `${providerId} connected.`);
        setBackendStatus(status);
        setLastAction(
          outcome === "configured"
            ? `${providerId} configured`
            : `${providerId} connected`,
        );
        return { providerId, outcome };
      }

      // offline / unsupported / failed: retain the key so the user can retry,
      // but do not let key presence clear onboarding or claim readiness.
      await refreshBackendProviders(providerId);
      if (!requests.isCurrent(token)) return staleConnection(providerId);
      setConnectedBackendIds((current) =>
        current.filter((id) => id !== providerId),
      );
      markProviderState(providerId, "unavailable");
      const status =
        message ??
        `${providerId} could not be verified. Retry before running an agent.`;
      setBackendStatus(status);
      setLastAction(status);
      return { providerId, outcome, message };
    } catch (error) {
      if (!requests.isCurrent(token)) return staleConnection(providerId);
      // Storage itself failed. Fail closed: do not report a connection.
      requests.finishMutation(token);
      void refreshBackendProviders();
      markProviderState(providerId, "needs-auth");
      const message =
        error instanceof Error
          ? error.message
          : `Could not connect ${providerId}.`;
      setBackendStatus(message);
      setLastAction(message);
      return { providerId, outcome: "failed", message };
    }
  };

  const connectBackend = async (
    providerId: string,
    secret = "preview-connection",
  ) => {
    await connectBackendWithVerify(providerId, secret);
  };

  const checkBackendConnectionOnce = async (
    providerId: string,
  ): Promise<BackendVerifyResult> => {
    const token = requests.capture(providerId);
    if (!requests.isCurrent(token)) return staleConnection(providerId);
    const provider = scopedBackendProviders.find(
      (entry) => entry.id === providerId,
    );
    if (!provider) {
      return {
        providerId,
        outcome: "failed",
        message: "This provider is not in Mivlet's runtime catalogue.",
      };
    }

    if (provider.id === "antigravity") {
      try {
        if (provider.authState === "install-required") {
          setBackendStatus("Installing Google's Antigravity ACP runtime…");
          await installRuntimeAntigravity();
          if (!requests.isCurrent(token)) return staleConnection(providerId);
          setBackendStatus("Opening Google sign-in…");
          const login = await startRuntimeAntigravityBrowserLogin();
          if (!requests.isCurrent(token)) return staleConnection(providerId);
          await refreshBackendProviders(providerId);
          if (!requests.isCurrent(token)) return staleConnection(providerId);
          const result: BackendVerifyResult = login
            ? { providerId, outcome: "ready", message: login.message }
            : {
                providerId,
                outcome: "unsupported",
                message: "Antigravity setup is available in the desktop app.",
              };
          setBackendStatus(result.message ?? "Antigravity connected.");
          return result;
        }
        const result = await checkRuntimeAntigravityConnection();
        if (!requests.isCurrent(token)) return staleConnection(providerId);
        await refreshBackendProviders(providerId);
        if (!requests.isCurrent(token)) return staleConnection(providerId);
        return (
          result ?? {
            providerId,
            outcome: "unsupported",
            message: "Antigravity checks run in the desktop app.",
          }
        );
      } catch (error) {
        if (!requests.isCurrent(token)) return staleConnection(providerId);
        const message =
          error instanceof Error
            ? error.message
            : "Antigravity could not be installed or connected.";
        await refreshBackendProviders(providerId);
        if (!requests.isCurrent(token)) return staleConnection(providerId);
        setBackendStatus(message);
        return { providerId, outcome: "failed", message };
      }
    }

    if (["claude", "cursor", "grok", "opencode"].includes(provider.id)) {
      const providerId = provider.id as ManagedRuntimeProviderId;
      try {
        if (
          provider.authState !== "install-required" &&
          provider.authState !== "connected" &&
          providerId !== "opencode"
        ) {
          setBackendStatus(`Opening the official ${provider.label} sign-in…`);
          await startRuntimeManagedLogin(providerId);
          if (!requests.isCurrent(token)) return staleConnection(providerId);
        }
        const result = await checkRuntimeManagedConnection(providerId);
        if (!requests.isCurrent(token)) return staleConnection(providerId);
        await refreshBackendProviders(providerId);
        if (!requests.isCurrent(token)) return staleConnection(providerId);
        const resolved = result ?? {
          providerId,
          outcome: "unsupported" as const,
          message: `${provider.label} setup is available in the desktop app.`,
        };
        setBackendStatus(
          resolved.message ?? `${provider.label} connection checked.`,
        );
        return resolved;
      } catch (error) {
        if (!requests.isCurrent(token)) return staleConnection(providerId);
        const message =
          error instanceof Error
            ? error.message
            : `${provider.label} could not be connected.`;
        await refreshBackendProviders(providerId);
        if (!requests.isCurrent(token)) return staleConnection(providerId);
        setBackendStatus(message);
        return { providerId, outcome: "failed", message };
      }
    }

    if (provider.backendType !== "native-api") {
      const refreshed = await refreshBackendProviders(providerId);
      if (!requests.isCurrent(token)) return staleConnection(providerId);
      const current =
        refreshed?.find((entry) => entry.id === providerId) ?? provider;
      const ready =
        current.authState === "connected" || current.authState === "ready";
      const result: BackendVerifyResult = ready
        ? { providerId, outcome: "ready" }
        : {
            providerId,
            outcome: "failed",
            message:
              current.installHint ??
              "The provider runtime is not connected yet.",
          };
      setBackendStatus(result.message ?? `${providerId} connection checked.`);
      return result;
    }

    const result = await requests.verify(providerId);
    if (!requests.isCurrent(token)) return staleConnection(providerId);
    if (result === null) {
      const previewResult: BackendVerifyResult = {
        providerId,
        outcome: "unsupported",
        message:
          "Browser preview uses a synthetic provider connection; live health checks run in the desktop app.",
      };
      setBackendStatus(previewResult.message ?? null);
      return previewResult;
    }

    if (result.outcome === "auth-failed") {
      await clearRuntimeBackend(providerId);
      if (!requests.isCurrent(token)) return staleConnection(providerId);
      await refreshBackendProviders(providerId);
      if (!requests.isCurrent(token)) return staleConnection(providerId);
      markProviderState(providerId, "needs-auth");
      setBackendStatus(
        result.message ?? `${providerId} rejected or revoked this key.`,
      );
      return result;
    }

    await refreshBackendProviders(providerId);
    if (!requests.isCurrent(token)) return staleConnection(providerId);
    setBackendStatus(
      result.message ??
        (result.outcome === "ready"
          ? `${providerId} is healthy.`
          : `${providerId} could not be checked right now.`),
    );
    return result;
  };

  const connectionChecks = useMemo(
    () => new Map<string, Promise<BackendVerifyResult>>(),
    [requests],
  );
  const checkBackendConnection = (
    providerId: string,
  ): Promise<BackendVerifyResult> => {
    const existing = connectionChecks.get(providerId);
    if (existing) return existing;
    const request = checkBackendConnectionOnce(providerId).finally(() => {
      if (connectionChecks.get(providerId) === request)
        connectionChecks.delete(providerId);
    });
    connectionChecks.set(providerId, request);
    return request;
  };

  const startBackendBrowserLogin = async (
    providerId: string,
  ): Promise<BackendVerifyResult> => {
    if (providerId !== "codex" && providerId !== "antigravity") {
      return {
        providerId,
        outcome: "unsupported",
        message:
          "This provider does not expose a supported browser sign-in through Mivlet.",
      };
    }
    const token = requests.invalidate(providerId);
    if (!requests.isCurrent(token)) return staleConnection(providerId);
    resetProviderDiscovery(providerId);
    markProviderState(providerId, "connecting");
    setBackendStatus(
      providerId === "codex"
        ? "Opening the official ChatGPT sign-in…"
        : "Opening the official Google sign-in…",
    );
    try {
      const started =
        providerId === "codex"
          ? await startRuntimeCodexBrowserLogin()
          : await (async () => {
              const status = backendProviders.find(
                (provider) => provider.id === providerId,
              );
              if (status?.authState === "install-required") {
                setBackendStatus("Preparing Google Antigravity…");
                await installRuntimeAntigravity();
                if (!requests.isCurrent(token))
                  return staleConnection(providerId);
              }
              setBackendStatus("Opening the official Google sign-in…");
              return startRuntimeAntigravityBrowserLogin();
            })();
      if (!requests.isCurrent(token)) return staleConnection(providerId);
      requests.finishMutation(token);
      if (!started) {
        markProviderState(providerId, "needs-auth");
        return {
          providerId,
          outcome: "unsupported",
          message: "Browser sign-in is available in the Mivlet desktop app.",
        };
      }
      // Antigravity's native sign-in already authenticates and creates a real
      // ACP session. Starting a second process immediately only repeats the
      // same check and can contend with the provider-owned profile teardown.
      let verified: BackendVerifyResult;
      if (providerId === "antigravity") {
        await refreshBackendProviders(providerId);
        if (!requests.isCurrent(token)) return staleConnection(providerId);
        verified = {
          providerId,
          outcome: "ready",
          message: started.message,
        };
      } else {
        verified = await checkBackendConnection(providerId);
        if (!requests.isCurrent(token)) return staleConnection(providerId);
      }
      const result =
        verified.outcome === "ready"
          ? { providerId, outcome: "ready" as const, message: started.message }
          : verified;
      setBackendStatus(result.message ?? "ChatGPT connected.");
      setLastAction(result.message ?? "ChatGPT connected");
      return result;
    } catch (error) {
      if (!requests.isCurrent(token)) return staleConnection(providerId);
      requests.finishMutation(token);
      markProviderState(providerId, "needs-auth");
      const message =
        error instanceof Error
          ? error.message
          : "Provider sign-in could not be completed.";
      setBackendStatus(message);
      setLastAction(message);
      return { providerId, outcome: "failed", message };
    }
  };

  const disconnectBackend = async (providerId: string) => {
    const token = requests.invalidate(providerId);
    if (!requests.isCurrent(token)) return;
    resetProviderDiscovery(providerId);
    markProviderState(providerId, "needs-auth");
    setConnectedBackendIds((current) =>
      current.filter((id) => id !== providerId),
    );
    setBackendStatus(`Disconnecting ${providerId}…`);
    try {
      if (providerId === "antigravity") {
        const cleared = await logoutRuntimeAntigravity();
        if (!requests.isCurrent(token)) return;
        if (cleared !== null) {
          requests.finishMutation(token);
          await refreshBackendProviders(providerId);
          if (!requests.isCurrent(token)) return;
          setBackendStatus("Antigravity disconnected.");
          setLastAction("Antigravity disconnected");
          return;
        }
      }
      if (["claude", "cursor", "grok", "opencode"].includes(providerId)) {
        const cleared = await logoutRuntimeManaged(
          providerId as ManagedRuntimeProviderId,
        );
        if (!requests.isCurrent(token)) return;
        if (cleared !== null) {
          requests.finishMutation(token);
          await refreshBackendProviders(providerId);
          if (!requests.isCurrent(token)) return;
          setBackendStatus(`${providerId} disconnected.`);
          setLastAction(`${providerId} disconnected`);
          return;
        }
      }
      const cleared = await clearRuntimeBackend(providerId);
      if (!requests.isCurrent(token)) return;
      requests.finishMutation(token);
      if (cleared === null) {
        setConnectedBackendIds((current) =>
          current.filter((id) => id !== providerId),
        );
        setBackendProviders((current) =>
          current.map((provider) =>
            provider.id === providerId
              ? {
                  ...provider,
                  authState:
                    provider.backendType === "codex-app-server"
                      ? "sign-in-required"
                      : "needs-auth",
                  capabilities: [],
                }
              : provider,
          ),
        );
        setBackendStatus(`${providerId} disconnected (preview).`);
        setLastAction(`${providerId} disconnected (preview)`);
        return;
      }

      await refreshBackendProviders(providerId);
      if (!requests.isCurrent(token)) return;
      setBackendStatus(`${providerId} disconnected.`);
      setLastAction(`${providerId} disconnected`);
    } catch (error) {
      if (!requests.isCurrent(token)) return;
      requests.finishMutation(token);
      void refreshBackendProviders();
      const message =
        error instanceof Error
          ? error.message
          : `Could not disconnect ${providerId}.`;
      setBackendStatus(message);
      setLastAction(message);
    }
  };
  return {
    connectedBackendIds:
      providerScopeGeneration === workspaceScopeGeneration &&
      requests.isCurrent()
        ? connectedBackendIds
        : [],
    setConnectedBackendIds,
    backendProviders: scopedBackendProviders,
    backendStatus,
    setBackendStatus,
    connectedAgentBackends,
    connectedAgentBackend,
    allModelOptions,
    modelOptions,
    selectableModels,
    resolvedSelectedModelId,
    resolvedModelOptionId,
    modelDiscoveryByProvider,
    refreshModels,
    refreshBackendProviders,
    connectBackendWithVerify,
    connectBackend,
    checkBackendConnection,
    startBackendBrowserLogin,
    disconnectBackend,
  };
}

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  BackendProvider,
  BackendVerifyOutcome,
  BackendVerifyResult,
} from "@fable/protocol";
import {
  hasRunnableAdapter,
  listBackendProviders,
  mergeDiscoveredModels,
  resolveCapabilities,
  type ModelDiscoveryResult,
} from "@fable/connectors";
import {
  modelsForProvider,
  providerModelOptions,
  resolveProviderModelOption,
} from "../../lib/provider-models";
import {
  clearRuntimeBackend,
  connectRuntimeBackend,
  listRuntimeBackends,
  listRuntimeBackendModels,
  checkRuntimeAntigravityConnection,
  checkRuntimeManagedConnection,
  installRuntimeAntigravity,
  logoutRuntimeAntigravity,
  logoutRuntimeManaged,
  startRuntimeAntigravityBrowserLogin,
  startRuntimeCodexBrowserLogin,
  startRuntimeManagedLogin,
  type ManagedRuntimeProviderId,
  verifyRuntimeBackend,
} from "../../runtime/domains/providers";
import { type PersistedShellState } from "../../lib/types";
import { hasTauriRuntime } from "../../lib/persistence";
import type { ModelDiscoveryOutcome } from "../../lib/backend-state";
import {
  enabledFableProviders,
  isFableProviderEnabled,
} from "../../lib/provider-availability";

async function resolveUsableBackendProviders(
  providers: BackendProvider[],
): Promise<BackendProvider[]> {
  const resolved = enabledFableProviders(providers);
  const nativeVerification = new Map<string, BackendVerifyResult | null>();

  await Promise.all(
    resolved
      .filter(
        (provider) =>
          provider.backendType === "native-api" &&
          provider.authState === "connected",
      )
      .map(async (provider) => {
        nativeVerification.set(
          provider.id,
          await verifyRuntimeBackend(provider.id),
        );
      }),
  );

  return resolved.map((provider) => {
    const verification = nativeVerification.get(provider.id);
    if (
      verification === undefined ||
      verification?.outcome === "ready" ||
      verification?.outcome === "configured"
    ) {
      return provider;
    }
    const authState =
      verification?.outcome === "auth-failed" ? "needs-auth" : "unavailable";
    return {
      ...provider,
      authState,
      capabilities: [],
      models: provider.models.map((model) => ({ ...model, available: false })),
      installHint:
        verification?.message ??
        "Mivlet could not verify this saved provider. Check the connection and try again.",
    };
  });
}

/** Provider setup, verification, discovery and model selection for one shell. */
export function useProviderConnections({
  initialState,
  selectedModelId,
  hiddenModelIds,
  setLastAction,
}: {
  initialState: PersistedShellState;
  selectedModelId: string;
  hiddenModelIds: string[];
  setLastAction: (message: string) => void;
}) {
  const [connectedBackendIds, setConnectedBackendIds] = useState<string[]>(
    hasTauriRuntime()
      ? []
      : initialState.connectedBackendIds.filter(isFableProviderEnabled),
  );

  // Agent-runtime backends. The Rust credential boundary resolves auth state
  // + capabilities; outside Tauri the preview registry is used so the workspace
  // shell stays testable. Preview connections remain visibly synthetic, while
  // the same provider gate is enforced in preview and native builds.
  const [backendProviders, setBackendProviders] = useState<BackendProvider[]>(
    () => enabledFableProviders(listBackendProviders()),
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

  // Every runnable connection participates in the model picker. Selection owns
  // routing: Mivlet no longer silently sends all prompts to the first connection.
  const connectedAgentBackends = useMemo(
    () =>
      backendProviders.filter(
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
    [backendProviders],
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

  useEffect(() => {
    let active = true;

    void listRuntimeBackends().then(async (providers) => {
      if (!active || !providers) {
        return;
      }

      const resolved = await resolveUsableBackendProviders(providers);

      if (!active) {
        return;
      }
      setBackendProviders(resolved);
      const connectedIds = resolved
        .filter((provider) => provider.authState === "connected")
        .map((provider) => provider.id);
      setConnectedBackendIds(connectedIds);
    });

    return () => {
      active = false;
    };
  }, []);

  // Dynamic model discovery: ask the Rust boundary to list a connected
  // provider's models (fail closed — no key in JS) and merge the result with the
  // curated catalogue. Outside Tauri this is a no-op so the catalogue fallback
  // drives selection and fixture tests stay green.
  //
  // `runModelDiscovery` is the single entry point for both the auto-run on
  // connect and the manual Settings "Refresh models" action. It drives the
  // per-provider lifecycle so Settings can show a spinner and recoverable
  // failure copy. `active` guards stale completions if the provider changes
  // mid-flight; the manual refresh path always resolves regardless (it sets
  // its own lifecycle entry).
  const runModelDiscovery = useCallback(
    async (providerId: string): Promise<void> => {
      setModelDiscoveryByProvider((current) => ({
        ...current,
        [providerId]: "loading",
      }));
      const result = await listRuntimeBackendModels(providerId);
      // null means preview/no desktop runtime. Mark this attempt unsupported so
      // the automatic discovery effect cannot spin idle -> loading -> idle.
      // A manual refresh can still call this entry point again.
      if (result === null) {
        setModelDiscoveryByProvider((current) => ({
          ...current,
          [providerId]: "unsupported",
        }));
        return;
      }
      setDiscoveredModels((current) => ({
        ...current,
        [providerId]: result,
      }));
      // Map the runtime outcome onto the UI lifecycle. `empty`/`offline`/
      // `unsupported`/`failed` are kept distinct so failed/offline never
      // masquerade as an empty account.
      setModelDiscoveryByProvider((current) => ({
        ...current,
        [providerId]: result.outcome,
      }));
      if (result.outcome === "failed") {
        setBackendStatus(
          result.message ??
            "Model discovery failed; using the curated catalogue.",
        );
      }
    },
    [],
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
      const provider = backendProviders.find(
        (entry) => entry.id === providerId,
      );
      if (!provider || provider.authState !== "connected") {
        return;
      }
      await runModelDiscovery(providerId);
    },
    [backendProviders, runModelDiscovery],
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
  const refreshBackendProviders = async () => {
    const refreshed = await listRuntimeBackends();
    if (refreshed) {
      const resolved = await resolveUsableBackendProviders(refreshed);
      setBackendProviders(resolved);
      setConnectedBackendIds(
        resolved
          .filter((provider) => provider.authState === "connected")
          .map((provider) => provider.id),
      );
      return resolved;
    }
    return null;
  };

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
    if (!isFableProviderEnabled(providerId)) {
      const message =
        "This provider is not available in the current Mivlet release.";
      setBackendStatus(message);
      return { providerId, outcome: "unsupported", message };
    }
    setBackendStatus(`Connecting ${providerId}…`);
    // Surface the connecting state on the provider card while the round-trip
    // is in flight. This is a transient UI state; the boundary re-resolves to
    // connected/needs-auth after verification.
    markProviderState(providerId, "connecting");
    try {
      const stored = await connectRuntimeBackend({ providerId, secret });
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
      const result = await verifyRuntimeBackend(providerId);
      // A missing verification command must never turn key storage into proof
      // of a usable provider. Browser preview returned earlier above.
      if (!result) {
        await clearRuntimeBackend(providerId);
        await refreshBackendProviders();
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
        await refreshBackendProviders();
        markProviderState(providerId, "needs-auth");
        const status =
          message ??
          `${providerId} rejected this key. Check the key and try again.`;
        setBackendStatus(status);
        setLastAction(status);
        return { providerId, outcome, message: status };
      }

      if (outcome === "ready" || outcome === "configured") {
        await refreshBackendProviders();
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
      await refreshBackendProviders();
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
      // Storage itself failed. Fail closed: do not report a connection.
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

  const checkBackendConnection = async (
    providerId: string,
  ): Promise<BackendVerifyResult> => {
    const provider = backendProviders.find((entry) => entry.id === providerId);
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
          setBackendStatus("Opening Google sign-in…");
          const login = await startRuntimeAntigravityBrowserLogin();
          await refreshBackendProviders();
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
        await refreshBackendProviders();
        return (
          result ?? {
            providerId,
            outcome: "unsupported",
            message: "Antigravity checks run in the desktop app.",
          }
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Antigravity could not be installed or connected.";
        await refreshBackendProviders();
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
        }
        const result = await checkRuntimeManagedConnection(providerId);
        await refreshBackendProviders();
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
        const message =
          error instanceof Error
            ? error.message
            : `${provider.label} could not be connected.`;
        await refreshBackendProviders();
        setBackendStatus(message);
        return { providerId, outcome: "failed", message };
      }
    }

    if (provider.backendType !== "native-api") {
      const refreshed = await refreshBackendProviders();
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

    const result = await verifyRuntimeBackend(providerId);
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
      await refreshBackendProviders();
      markProviderState(providerId, "needs-auth");
      setBackendStatus(
        result.message ?? `${providerId} rejected or revoked this key.`,
      );
      return result;
    }

    await refreshBackendProviders();
    setBackendStatus(
      result.message ??
        (result.outcome === "ready"
          ? `${providerId} is healthy.`
          : `${providerId} could not be checked right now.`),
    );
    return result;
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
              }
              setBackendStatus("Opening the official Google sign-in…");
              return startRuntimeAntigravityBrowserLogin();
            })();
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
        await refreshBackendProviders();
        verified = {
          providerId,
          outcome: "ready",
          message: started.message,
        };
      } else {
        verified = await checkBackendConnection(providerId);
      }
      const result =
        verified.outcome === "ready"
          ? { providerId, outcome: "ready" as const, message: started.message }
          : verified;
      setBackendStatus(result.message ?? "ChatGPT connected.");
      setLastAction(result.message ?? "ChatGPT connected");
      return result;
    } catch (error) {
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
    setBackendStatus(`Disconnecting ${providerId}…`);
    try {
      if (providerId === "antigravity") {
        const cleared = await logoutRuntimeAntigravity();
        if (cleared !== null) {
          await refreshBackendProviders();
          setBackendStatus("Antigravity disconnected.");
          setLastAction("Antigravity disconnected");
          return;
        }
      }
      if (["claude", "cursor", "grok", "opencode"].includes(providerId)) {
        const cleared = await logoutRuntimeManaged(
          providerId as ManagedRuntimeProviderId,
        );
        if (cleared !== null) {
          await refreshBackendProviders();
          setBackendStatus(`${providerId} disconnected.`);
          setLastAction(`${providerId} disconnected`);
          return;
        }
      }
      const cleared = await clearRuntimeBackend(providerId);
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

      await refreshBackendProviders();
      setBackendStatus(`${providerId} disconnected.`);
      setLastAction(`${providerId} disconnected`);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `Could not disconnect ${providerId}.`;
      setBackendStatus(message);
      setLastAction(message);
    }
  };
  return {
    connectedBackendIds,
    setConnectedBackendIds,
    backendProviders,
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

import { createWorkspaceContext } from "./shell-runtime/workspace-context";
import { useMemoryControls } from "./shell-runtime/useMemoryControls";
import {
  importLocalTextFile,
  normalizeCustomApprovalSettings,
  resolvePermissionModeFromCustom,
  type LocalTextFileCandidate,
} from "@mivlet/connectors";
import { isLiveSource } from "@mivlet/knowledge";
import type {
  ConnectorAccountOption,
  ConnectorManifest,
  CustomApprovalSettings,
  MivletAgentProfile,
  KnowledgeSource,
  LocalFileImport,
  MemoryControlState,
  MemoryRecord,
  PermissionMode,
} from "@mivlet/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isApprovalPresetLabel,
  permissionLabelFor,
  permissionModeFor,
} from "../lib/agent-run";
import { CONNECTOR_CONNECTIONS_CHANGED } from "../lib/connector-connections";
import { listVerifiedConnectorStatuses as listRuntimeConnectorStatuses } from "../lib/load-connector-connections";
import { useAccountWorkspace } from "./shell-runtime/useAccountWorkspace";
import { useProviderConnections } from "./shell-runtime/useProviderConnections";
import { useWorkspaceApprovals } from "./shell-runtime/useWorkspaceApprovals";
import { useWorkspaceSnapshot } from "./shell-runtime/useWorkspaceSnapshot";

import { connectors, knowledgeSources } from "../data/workspace";
import {
  beginRuntimeConnectorOAuth,
  clearRuntimeConnectorAuth,
  listRuntimeConnectorAccounts,
  listRuntimeConnectorKnowledgeSources,
  listRuntimeConnectorSyncStates,
  refreshRuntimeConnectorHealth,
  switchRuntimeConnectorAccount,
  syncRuntimeConnector,
} from "../runtime/domains/connectors";

import { MAX_IMPORTED_KNOWLEDGE_SOURCES } from "../lib/constants";
import { mergeKnowledgeSources, readFileAsText } from "../lib/helpers";
import { hasTauriRuntime, readPersistedShellState } from "../lib/persistence";
import { type PersistedShellState } from "../lib/types";
import {
  importRuntimeLocalKnowledgeSource,
  loadRuntimeImportedKnowledgeSources,
  loadRuntimeMemoryState,
} from "../runtime/domains/memory";

import { isMivletProviderEnabled } from "../lib/provider-availability";
import { isSupportedConnectorId } from "./shell-runtime/backend-normalization";
import {
  defaultShellState,
  FIRST_AGENT_ONBOARDING_VERSION,
} from "./shell-runtime/defaults";
import type {
  ShellRuntime,
  UseShellRuntimeOptions,
} from "./shell-runtime/types";

export type {
  ShellRuntime,
  UseShellRuntimeOptions,
} from "./shell-runtime/types";

/** Coordinates the account, snapshot, approval and provider owners with workspace settings and context. */
export function useShellRuntime(
  options: UseShellRuntimeOptions = {},
): ShellRuntime {
  const initialState = useMemo(
    () =>
      // Desktop: the account-owned runtime snapshot is the source of truth;
      // ambiguous installation-local browser data is never adopted. Preview: localStorage
      // remains the sole store.
      hasTauriRuntime()
        ? defaultShellState
        : readPersistedShellState(defaultShellState),
    [],
  );
  const [activeItem, setActiveItem] = useState(initialState.activeItem);

  const [voiceEnabled, setVoiceEnabled] = useState(initialState.voiceEnabled);
  const [voiceProvider, setVoiceProvider] = useState<"browser" | "openai">(
    initialState.voiceProvider === "openai" ? "openai" : "browser",
  );

  const [lastAction, setLastAction] = useState("Workspace ready");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    initialState.permissionMode,
  );
  const [permissionLabel, setPermissionLabel] = useState(
    isApprovalPresetLabel(initialState.permissionLabel)
      ? initialState.permissionLabel
      : permissionLabelFor(initialState.permissionMode),
  );
  const [customApprovalSettings, setCustomApprovalSettings] =
    useState<CustomApprovalSettings>(
      normalizeCustomApprovalSettings(initialState.customApprovalSettings),
    );

  const account = useAccountWorkspace({
    setLastAction,
    onScopeChange: () => {
      options.approvalGate?.cancelPending();
      options.onScopeReset?.();
      snapshot.invalidate();
      approvals.reset();
    },
    shouldReload: () => snapshot.shouldReload(),
  });
  const {
    workspaceScopeGeneration,
    workspaceIdentityRef,
    activeWorkspaceScope,
  } = account;
  const { identityStatus, accountWorkspaceStatus } = account.runtime;
  const approvals = useWorkspaceApprovals({
    initialState,
    workspaceIdentityRef,
    workspaceScopeGeneration,
    permissionMode,
    approvalGate: options.approvalGate ?? null,
    setLastAction,
  });
  const { dismissedApprovalIds } = approvals;
  const { approvalAudit, approvalRules } = approvals.runtime;
  const [agents, setAgents] = useState<MivletAgentProfile[]>(
    initialState.agents?.length
      ? initialState.agents
      : (defaultShellState.agents ?? []),
  );
  const [activeAgentId, setActiveAgentId] = useState(
    initialState.activeAgentId ??
      initialState.agents?.[0]?.id ??
      "chief-of-staff",
  );
  const [pinnedSourceIds, setPinnedSourceIds] = useState<string[]>(
    initialState.pinnedSourceIds,
  );
  const [importedKnowledgeSources, setImportedKnowledgeSources] = useState<
    LocalFileImport[]
  >(initialState.importedKnowledgeSources);
  const [importStatus, setImportStatus] = useState<string | null>(null);

  const [connectorManifests, setConnectorManifests] =
    useState<ConnectorManifest[]>(connectors);
  const connectorScopeRef = useRef(workspaceScopeGeneration);
  connectorScopeRef.current = workspaceScopeGeneration;
  const refreshConnectorStatuses = useCallback(async () => {
    const scopeGeneration = connectorScopeRef.current;
    const latest = await listRuntimeConnectorStatuses();
    if (scopeGeneration !== connectorScopeRef.current) return null;
    if (latest && scopeGeneration === connectorScopeRef.current) {
      setConnectorManifests((current) =>
        latest.map((manifest) => {
          const previous = current.find(
            (candidate) => candidate.id === manifest.id,
          );
          return previous?.sync
            ? { ...manifest, sync: previous.sync }
            : manifest;
        }),
      );
    }
    return latest;
  }, []);
  useEffect(() => {
    const refresh = () => {
      void refreshConnectorStatuses().catch(() => undefined);
    };
    window.addEventListener("focus", refresh);
    window.addEventListener(CONNECTOR_CONNECTIONS_CHANGED, refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener(CONNECTOR_CONNECTIONS_CHANGED, refresh);
    };
  }, [refreshConnectorStatuses]);
  const [connectorAccounts, setConnectorAccounts] = useState<
    Record<string, ConnectorAccountOption[]>
  >({});
  const [connectorStatus, setConnectorStatus] = useState<string | null>(null);
  const connectorOperations = useRef(new Map<string, Promise<void>>());
  const [connectorImportedSources, setConnectorImportedSources] = useState<
    KnowledgeSource[]
  >([]);
  const [managedMemoryRecords, setManagedMemoryRecords] = useState<
    MemoryRecord[]
  >(initialState.memoryRecords);
  const [memoryDisabled, setMemoryDisabled] = useState(
    initialState.memoryDisabled,
  );
  const [memoryExportText, setMemoryExportText] = useState("");
  const [memoryStatus, setMemoryStatus] = useState("Memory ready");
  const [onboardingDismissed, setOnboardingDismissed] = useState(
    initialState.onboardingComplete ?? false,
  );
  const [onboardingVersion, setOnboardingVersion] = useState(
    initialState.onboardingVersion ?? 0,
  );
  const firstAgentSetupAttemptRef = useRef<{
    generation: number;
    pendingToken: number | null;
    nextToken: number;
  }>({ generation: workspaceScopeGeneration, pendingToken: null, nextToken: 0 });
  useEffect(() => {
    firstAgentSetupAttemptRef.current = {
      generation: workspaceScopeGeneration,
      pendingToken: null,
      nextToken: firstAgentSetupAttemptRef.current.nextToken + 1,
    };
  }, [workspaceScopeGeneration]);
  // Composer model + permission picker selections, persisted so the next run
  // uses them. The model is re-validated against the connected backend's
  // available models before each run (see resolveSelectedModel).
  const [selectedModelId, setSelectedModelId] = useState(
    initialState.selectedModelId,
  );
  const [hiddenModelIds, setHiddenModelIds] = useState<string[]>(
    initialState.hiddenModelIds ?? [],
  );
  const {
    connectedBackendIds,
    setConnectedBackendIds,
    backendProviders,
    backendStatus,
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
  } = useProviderConnections({
    initialState,
    workspaceScopeGeneration,
    workspaceIdentityRef,
    selectedModelId,
    hiddenModelIds,
    setLastAction,
  });
  const workspaceKnowledgeSources = useMemo(
    () =>
      mergeKnowledgeSources(hasTauriRuntime() ? [] : knowledgeSources, [
        ...connectorImportedSources,
        ...importedKnowledgeSources,
      ]).filter((source) => !source.deletedAt),
    [connectorImportedSources, importedKnowledgeSources],
  );
  const memoryState = useMemo<MemoryControlState>(
    () => ({
      disabled: memoryDisabled,
      records: managedMemoryRecords,
    }),
    [managedMemoryRecords, memoryDisabled],
  );
  const shellState = useMemo<PersistedShellState>(
    () => ({
      activeItem,
      composerValue: "",
      voiceEnabled,
      voiceProvider,
      approvalAudit,
      dismissedApprovalIds,
      approvalRules,
      agents,
      activeAgentId,
      pinnedSourceIds,
      importedKnowledgeSources,
      memoryDisabled,
      memoryRecords: managedMemoryRecords,
      connectedBackendIds,
      onboardingComplete: onboardingDismissed,
      onboardingVersion,
      selectedModelId,
      hiddenModelIds,
      permissionMode,
      permissionLabel,
      customApprovalSettings,
    }),
    [
      activeItem,
      approvalAudit,
      approvalRules,
      agents,
      activeAgentId,
      connectedBackendIds,
      onboardingDismissed,
      onboardingVersion,
      customApprovalSettings,
      dismissedApprovalIds,
      importedKnowledgeSources,
      managedMemoryRecords,
      memoryDisabled,
      permissionMode,
      permissionLabel,
      pinnedSourceIds,
      selectedModelId,
      hiddenModelIds,
      voiceEnabled,
      voiceProvider,
    ],
  );

  const snapshot = useWorkspaceSnapshot({
    shellState,
    workspaceIdentityRef,
    workspaceScopeGeneration,
    activeWorkspaceScope,
    setLastAction,
    onReset: () => {
      setActiveItem(defaultShellState.activeItem);

      setAgents(defaultShellState.agents ?? []);
      setActiveAgentId(defaultShellState.activeAgentId ?? "chief-of-staff");
      setOnboardingDismissed(false);
      setOnboardingVersion(FIRST_AGENT_ONBOARDING_VERSION);
      setPinnedSourceIds([]);
      setImportedKnowledgeSources([]);
      setImportStatus(null);

      setConnectorImportedSources([]);
      setConnectorManifests(connectors);
      setConnectorAccounts({});
      setConnectorStatus(null);
      setManagedMemoryRecords([]);
      setMemoryDisabled(false);
      setMemoryExportText("");
    },
    onHydrate: (recovered) => {
      approvals.hydrate(recovered);
      setActiveItem(recovered.activeItem);

      setVoiceEnabled(recovered.voiceEnabled);
      setVoiceProvider(
        recovered.voiceProvider === "openai" ? "openai" : "browser",
      );
      setAgents(
        recovered.agents?.length
          ? recovered.agents
          : (defaultShellState.agents ?? []),
      );
      setActiveAgentId(
        recovered.activeAgentId ??
          recovered.agents?.[0]?.id ??
          "chief-of-staff",
      );
      setPinnedSourceIds(recovered.pinnedSourceIds);
      setImportedKnowledgeSources(recovered.importedKnowledgeSources);
      setMemoryDisabled(recovered.memoryDisabled);
      setManagedMemoryRecords(
        recovered.memoryRecords.filter((record) => !record.forgottenAt),
      );
      // A saved snapshot records the user's previous provider choice, not
      // proof that credentials are still valid. Native connected state is
      // restored only by the live provider probes above.
      if (!hasTauriRuntime()) {
        setConnectedBackendIds(
          recovered.connectedBackendIds.filter(isMivletProviderEnabled),
        );
      }
      setOnboardingDismissed(recovered.onboardingComplete ?? false);
      setOnboardingVersion(recovered.onboardingVersion ?? 0);
      setSelectedModelId(recovered.selectedModelId);
      setHiddenModelIds(recovered.hiddenModelIds ?? []);
      setPermissionMode(recovered.permissionMode);
      setPermissionLabel(
        isApprovalPresetLabel(recovered.permissionLabel)
          ? recovered.permissionLabel
          : permissionLabelFor(recovered.permissionMode),
      );
      setCustomApprovalSettings(
        normalizeCustomApprovalSettings(recovered.customApprovalSettings),
      );
    },
  });

  useEffect(() => {
    let active = true;

    void loadRuntimeImportedKnowledgeSources().then((sources) => {
      if (!active || !sources || sources.length === 0) {
        return;
      }

      setImportedKnowledgeSources(sources);
      setPinnedSourceIds((current) =>
        Array.from(
          new Set([...current, ...sources.map((source) => source.id)]),
        ),
      );
    });

    return () => {
      active = false;
    };
  }, [workspaceScopeGeneration]);

  useEffect(() => {
    let active = true;

    void listRuntimeConnectorKnowledgeSources()
      .then((sources) => {
        if (active && sources) {
          setConnectorImportedSources(sources);
        }
      })
      .catch((error) => {
        if (active) {
          setImportStatus(
            error instanceof Error
              ? error.message
              : "Mivlet could not load connector knowledge.",
          );
        }
      });

    return () => {
      active = false;
    };
  }, [workspaceScopeGeneration]);

  useEffect(() => {
    let active = true;

    void loadRuntimeMemoryState().then((state) => {
      if (
        !active ||
        !state ||
        (!state.disabled && state.records.length === 0)
      ) {
        return;
      }

      setMemoryDisabled(state.disabled);
      setManagedMemoryRecords(state.records);
    });

    return () => {
      active = false;
    };
  }, [workspaceScopeGeneration]);

  // Resolve agent-runtime backend auth state + capabilities from the Rust
  // credential boundary. Outside Tauri the preview registry is kept. Secrets
  // never reach this layer — only auth state and capabilities.
  useEffect(() => {
    let active = true;

    void Promise.all([
      listRuntimeConnectorStatuses(),
      listRuntimeConnectorSyncStates(),
    ]).then(async ([manifests, syncStates]) => {
      if (!active || !manifests) {
        return;
      }
      const connectionEntries = await Promise.all(
        manifests
          // MCP manifests may describe a connected tool with its own account
          // model. The account command is intentionally limited to Mivlet's
          // built-in connector IDs, so never ask native to resolve an
          // arbitrary custom MCP identifier.
          .filter(
            (manifest) =>
              manifest.status === "connected" &&
              isSupportedConnectorId(manifest.id),
          )
          .map(
            async (manifest) =>
              [
                manifest.id,
                (await listRuntimeConnectorAccounts(manifest.id)) ?? [],
              ] as const,
          ),
      );
      if (!active) return;
      const syncById = new Map(
        syncStates?.map((state) => [state.connectorId, state]) ?? [],
      );
      const runtimeById = new Map(
        manifests.map((manifest) => [manifest.id, manifest]),
      );
      setConnectorAccounts(Object.fromEntries(connectionEntries));
      setConnectorManifests((current) =>
        current.map((manifest) => {
          const runtime = runtimeById.get(manifest.id) ?? manifest;
          const sync = syncById.get(manifest.id);
          return sync ? { ...runtime, sync } : runtime;
        }),
      );
    });

    return () => {
      active = false;
    };
  }, [workspaceScopeGeneration]);

  const toggleVoice = () => {
    setVoiceEnabled((enabled) => {
      setLastAction(enabled ? "Voice paused" : "Voice ready");
      return !enabled;
    });
  };

  const addImportedKnowledgeSource = (source: LocalFileImport) => {
    setImportedKnowledgeSources((current) =>
      [
        source,
        ...current.filter((existing) => existing.id !== source.id),
      ].slice(0, MAX_IMPORTED_KNOWLEDGE_SOURCES),
    );
    setPinnedSourceIds((current) =>
      current.includes(source.id) ? current : [...current, source.id],
    );
  };

  const importLocalKnowledgeFile = async (
    file: File,
    sourceName = file.name,
    onImported?: (sourceId: string) => void,
    decodedContent?: string,
  ) => {
    const importScope = connectorScopeRef.current;
    setImportStatus(`Reading ${sourceName}...`);

    try {
      const content = decodedContent ?? (await readFileAsText(file));
      if (connectorScopeRef.current !== importScope) return null;
      const candidate: LocalTextFileCandidate = {
        name: sourceName,
        content,
        sizeBytes: file.size,
        importedAt: new Date().toISOString(),
      };
      // Surface the indexing state before the (async) native import resolves so
      // the user sees the source move reading -> indexing -> indexed.
      setImportStatus(`Indexing ${sourceName}...`);
      const nativeImported = await importRuntimeLocalKnowledgeSource(candidate);
      if (connectorScopeRef.current !== importScope) return null;
      const imported = nativeImported ?? importLocalTextFile(candidate);
      // The imported source is indexed and healthy. Unchanged re-imports (same
      // content fingerprint) replace the existing row in place via
      // addImportedKnowledgeSource's dedupe-by-id, so no phantom duplicate rows
      // appear for unchanged imports.
      const indexed: LocalFileImport = {
        ...imported,
        status: "ok",
        statusMessage: undefined,
      };

      if (
        importedKnowledgeSources.some(
          (source) => source.id === imported.id && source.deletedAt,
        )
      ) {
        throw new Error(
          "Deleted knowledge cannot be restored by a backup import.",
        );
      }

      addImportedKnowledgeSource(indexed);
      onImported?.(indexed.id);
      setImportStatus(
        `Imported ${indexed.title}. It is pinned as untrusted knowledge.`,
      );
      setLastAction(`Imported source: ${indexed.title}`);
      return indexed.id;
    } catch (error) {
      if (connectorScopeRef.current !== importScope) return null;
      const message =
        error instanceof Error
          ? error.message
          : "Mivlet could not import that file.";
      // Import failure must not leave a phantom source or stale optimistic
      // state: nothing was added, so we surface the failure and clear indexing.
      setImportStatus(message);
      setLastAction(message);
      return null;
    }
  };

  const { assembleConversationContext } = createWorkspaceContext({
    connectorAccounts,
    workspaceKnowledgeSources,
    managedMemoryRecords,
    memoryDisabled,
    accountWorkspaceStatus,
  });

  const {
    toggleMemoryPin,
    forgetMemory,
    addChatMemory,
    approveMemory,
    refreshMemories,
    correctMemory,
    toggleMemoryRecordDisabled,
    toggleMemoryDisabled,
    exportMemory,
  } = useMemoryControls({
    memoryDisabled,
    managedMemoryRecords,
    memoryState,
    connectorScopeRef,
    setMemoryDisabled,
    setManagedMemoryRecords,
    setMemoryStatus,
    setMemoryExportText,
  });

  const replaceConnectorManifest = (manifest: ConnectorManifest) => {
    setConnectorManifests((current) =>
      current.map((connector) =>
        connector.id === manifest.id ? manifest : connector,
      ),
    );
  };

  const connectConnector = (connector: ConnectorManifest): Promise<void> => {
    const generation = connectorScopeRef.current;
    const key = `${generation}:${connector.id}`;
    const pending = connectorOperations.current.get(key);
    if (pending) return pending;
    const task = (async () => {
      if (!isSupportedConnectorId(connector.id)) {
        setConnectorStatus(
          connector.id === "local-files"
            ? "Local Files is already available."
            : (connector.setupMessage ??
                `${connector.name} is not in the first connector wave.`),
        );
        return;
      }

      setConnectorStatus(`Preparing ${connector.name} authorization...`);
      try {
        // Every OAuth connector runs the full loopback flow end-to-end. Public
        // Google clients call Google directly; confidential connectors route
        // exchange through the configured broker and fail closed if it is absent.
        const result = await beginRuntimeConnectorOAuth({
          connectorId: connector.id,
          requestedScopes: connector.scopes?.length
            ? connector.scopes.map((scope) => scope.id)
            : undefined,
        });
        if (!result) {
          const message = `${connector.name} connections require the installed desktop app.`;
          setConnectorStatus(message);
          setLastAction(message);
          throw new Error(message);
        }
        // On a real connection, re-read the boundary so the manifest reflects the
        // live account, granted scopes, and (after refresh) provider health.
        if (result.status === "connected") {
          if (connectorScopeRef.current !== generation) return;
          const refreshed = await refreshRuntimeConnectorHealth(connector.id);
          if (connectorScopeRef.current !== generation) return;
          if (refreshed) {
            replaceConnectorManifest(refreshed);
          }
          if (
            !refreshed ||
            refreshed.status !== "connected" ||
            refreshed.health?.state !== "healthy"
          ) {
            throw new Error(
              refreshed?.healthSummary ??
                "Could not finish connecting. Try again.",
            );
          }
          await loadConnectorAccounts(connector.id);
        } else {
          throw new Error(
            result.message || "Sign-in did not finish. Try again.",
          );
        }
        if (connectorScopeRef.current !== generation) return;
        setConnectorStatus(result.message);
        setLastAction(result.message);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : `${connector.name} authorization is unavailable.`;
        if (connectorScopeRef.current !== generation) throw new Error(message);
        setConnectorStatus(message);
        setLastAction(message);
        throw new Error(message);
      }
    })().finally(() => {
      connectorOperations.current.delete(key);
    });
    connectorOperations.current.set(key, task);
    return task;
  };

  const disconnectConnector = async (connectorId: string) => {
    const generation = connectorScopeRef.current;
    const connector = connectorManifests.find(
      (manifest) => manifest.id === connectorId,
    );
    if (!connector || !isSupportedConnectorId(connectorId)) {
      return;
    }

    try {
      const manifest = await clearRuntimeConnectorAuth(connectorId);
      if (connectorScopeRef.current !== generation) return;
      if (manifest) {
        replaceConnectorManifest(manifest);
        setConnectorStatus(`${connector.name} disconnected.`);
      } else {
        throw new Error(
          `${connector.name} connections require the installed desktop app.`,
        );
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `${connector.name} could not be disconnected.`;
      if (connectorScopeRef.current === generation) setConnectorStatus(message);
      throw new Error(message);
    }
  };

  const loadConnectorAccounts = async (connectorId: string) => {
    if (!isSupportedConnectorId(connectorId)) return;
    try {
      const accounts = await listRuntimeConnectorAccounts(connectorId);
      if (accounts) {
        setConnectorAccounts((current) => ({
          ...current,
          [connectorId]: accounts,
        }));
      }
    } catch (error) {
      setConnectorStatus(
        error instanceof Error
          ? error.message
          : "Connected accounts are unavailable.",
      );
    }
  };

  const switchConnectorAccount = async (
    connectorId: string,
    connectionId: string,
  ) => {
    if (!isSupportedConnectorId(connectorId)) return;
    try {
      const manifest = await switchRuntimeConnectorAccount(
        connectorId,
        connectionId,
      );
      if (manifest) {
        replaceConnectorManifest(manifest);
        await loadConnectorAccounts(connectorId);
        setConnectorStatus(
          `Using ${manifest.account?.email ?? manifest.account?.displayName ?? "selected account"}.`,
        );
      }
    } catch (error) {
      setConnectorStatus(
        error instanceof Error
          ? error.message
          : "The account could not be selected.",
      );
    }
  };

  const refreshConnector = async (connectorId: string) => {
    const connector = connectorManifests.find(
      (manifest) => manifest.id === connectorId,
    );
    if (!connector || !isSupportedConnectorId(connectorId)) {
      return;
    }

    try {
      const sync = await syncRuntimeConnector({
        connectorId,
        workspaceId: activeWorkspaceScope?.workspaceId ?? "",
        trigger: "manual",
      });
      if (sync) {
        replaceConnectorManifest({ ...connector, sync });
        const outcome =
          sync.phase === "succeeded"
            ? "sync complete"
            : (sync.failure?.message ?? `sync ${sync.phase}`);
        setConnectorStatus(`${connector.name} ${outcome}.`);
      } else {
        setConnectorStatus(
          `${connector.name} sync is unavailable in preview mode.`,
        );
      }
    } catch (error) {
      setConnectorStatus(
        error instanceof Error
          ? error.message
          : `${connector.name} health is unavailable.`,
      );
    }
  };

  // Account readiness is separate from the provider setup gate in the shell.
  const onboardingRequired =
    !(
      identityStatus.state === "signed-in" ||
      (identityStatus.state === "offline" &&
        Boolean(identityStatus.authentication))
    ) || !activeWorkspaceScope;

  // Version 2 is the first journey that asks for an original agent. A
  // missing/zero version is deliberately treated as a legacy returning
  // account, so upgrading never surprises an existing workspace.
  const firstAgentSetupRequired =
    onboardingVersion === FIRST_AGENT_ONBOARDING_VERSION &&
    !onboardingDismissed;

  // Composer picker bindings: the model picker drives request.model on the next
  // agent run; the approval preset maps its label onto a PermissionMode that
  // gates tool execution in the agent loop.
  const selectModel = (modelId: string) => {
    const chosen = allModelOptions.find(
      (model) => model.id === modelId || model.modelId === modelId,
    );
    setSelectedModelId(chosen?.id ?? modelId);
    setLastAction(
      chosen
        ? `${chosen.providerLabel} · ${chosen.label} selected`
        : "Model cleared",
    );
  };

  const selectPermissionLabel = (label: string) => {
    if (!isApprovalPresetLabel(label)) {
      return;
    }
    setPermissionLabel(label);
    setPermissionMode(
      label === "Custom"
        ? resolvePermissionModeFromCustom(customApprovalSettings)
        : permissionModeFor(label),
    );
    setLastAction(`Approval preset set to ${label}`);
  };

  const updateCustomApprovalSetting = (
    key: keyof CustomApprovalSettings,
    value: boolean,
  ) => {
    setCustomApprovalSettings((current) => {
      const next = normalizeCustomApprovalSettings({
        ...current,
        [key]: value,
      });
      setPermissionLabel("Custom");
      setPermissionMode(resolvePermissionModeFromCustom(next));
      return next;
    });
    setLastAction("Custom approvals updated");
  };

  const completeFirstAgentSetup = async (setup: {
    name: string;
    instructions: string;
    avatarSeed: string;
    iconColor: string;
  }) => {
    const attempt = firstAgentSetupAttemptRef.current;
    if (attempt.generation !== workspaceScopeGeneration) {
      throw new Error("The workspace changed before your first agent could be saved.");
    }
    if (attempt.pendingToken !== null) {
      throw new Error("Your first agent is still being saved.");
    }
    if (!firstAgentSetupRequired) {
      throw new Error("Your first agent is already set up.");
    }
    if (!connectedAgentBackends.length) {
      throw new Error("Connect a usable provider before continuing.");
    }
    const name = setup.name.trim();
    if (!name) throw new Error("Give your agent a name before continuing.");
    const original =
      agents.find((agent) => agent.id === "chief-of-staff") ?? agents[0];
    if (!original) throw new Error("Mivlet could not find your first agent.");
    const updated: MivletAgentProfile = {
      ...original,
      name,
      instructions: setup.instructions.trim(),
      avatarSeed: setup.avatarSeed,
      iconColor: /^#[0-9a-f]{6}$/i.test(setup.iconColor)
        ? setup.iconColor.toUpperCase()
        : original.iconColor,
    };
    const nextShellState: PersistedShellState = {
      ...shellState,
      agents: shellState.agents?.map((agent) =>
        agent.id === original.id ? updated : agent,
      ),
      activeAgentId: original.id,
      onboardingComplete: true,
      onboardingVersion: FIRST_AGENT_ONBOARDING_VERSION,
    };
    const expectedIdentity = workspaceIdentityRef.current;
    const expectedWorkspaceId = activeWorkspaceScope?.workspaceId;
    if (
      hasTauriRuntime() &&
      (!snapshot.runtime.runtimeSnapshotReady ||
        !expectedIdentity ||
        !expectedWorkspaceId)
    ) {
      throw new Error("Wait for workspace settings to load.");
    }
    const token = ++attempt.nextToken;
    attempt.pendingToken = token;
    try {
      if (hasTauriRuntime()) {
        await snapshot.runtime.flushSnapshot(nextShellState);
        if (
          workspaceIdentityRef.current !== expectedIdentity ||
          activeWorkspaceScope?.workspaceId !== expectedWorkspaceId
        ) {
          throw new Error(
            "The workspace changed before your first agent could be saved.",
          );
        }
      }
      if (
        firstAgentSetupAttemptRef.current !== attempt ||
        firstAgentSetupAttemptRef.current.generation !== workspaceScopeGeneration ||
        firstAgentSetupAttemptRef.current.pendingToken !== token
      ) {
        throw new Error("The workspace changed before your first agent could be saved.");
      }
      setAgents(nextShellState.agents ?? []);
      setActiveAgentId(original.id);
      setOnboardingDismissed(true);
      setOnboardingVersion(FIRST_AGENT_ONBOARDING_VERSION);
    } finally {
      if (attempt.pendingToken === token) attempt.pendingToken = null;
    }
  };

  const createAgent = (input: Omit<MivletAgentProfile, "id" | "threadId">) => {
    // Keep identifier construction distinct from dynamic CSS class prefixes.
    const id = ["agent", globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)].join("-");
    const created: MivletAgentProfile = {
      ...input,
      id,
      icon: "agent",
      avatarSeed: input.avatarSeed ?? `blob-v1:${id}`,
      iconColor: /^#[0-9a-f]{6}$/i.test(input.iconColor)
        ? input.iconColor
        : "#865DFA",
    };
    setAgents((current) => [...current, created]);
    setActiveAgentId(id);
    setActiveItem(id);
    selectModel(created.modelId);
    return created;
  };

  const updateAgent = (
    agentId: string,
    patch: Partial<Omit<MivletAgentProfile, "id">>,
  ) => {
    setAgents((current) =>
      current.map((agent) =>
        agent.id === agentId
          ? {
              ...agent,
              ...patch,
              threadIds: patch.threadIds ?? [
                ...new Set([
                  ...(agent.threadIds ?? []),
                  ...(agent.threadId ? [agent.threadId] : []),
                  ...(patch.threadId ? [patch.threadId] : []),
                ]),
              ],
            }
          : agent,
      ),
    );
    if (agentId === activeAgentId) {
      if (patch.modelId !== undefined) selectModel(patch.modelId);
    }
  };

  const removeAgent = (agentId: string) => {
    if (agents.length <= 1) return;
    const remaining = agents.filter((agent) => agent.id !== agentId);
    setAgents(remaining);
    if (activeAgentId === agentId) {
      const next = remaining[0];
      if (next) {
        setActiveAgentId(next.id);
        setActiveItem(next.id);
        selectModel(next.modelId);
      }
    }
  };

  return {
    ...account.runtime,
    ...approvals.runtime,
    ...snapshot.runtime,
    activeItem,
    setActiveItem,

    agents,
    activeAgentId,
    firstAgentSetupRequired,
    completeFirstAgentSetup,
    createAgent,
    updateAgent,
    removeAgent,

    voiceEnabled,
    setVoiceEnabled,
    voiceProvider,
    setVoiceProvider,
    toggleVoice,
    setImportStatus,

    importStatus,

    connectorManifests,
    refreshConnectorStatuses,
    connectorAccounts,
    connectorStatus,
    connectorImportedSources,
    connectConnector,
    disconnectConnector,
    refreshConnector,
    loadConnectorAccounts,
    switchConnectorAccount,
    workspaceKnowledgeSources,
    importKnowledgeFile: (file: File, decodedContent?: string) =>
      importLocalKnowledgeFile(file, file.name, undefined, decodedContent),
    pinnedSourceIds,
    managedMemoryRecords,
    memoryDisabled,
    memoryState,
    memoryExportText,
    memoryStatus,
    toggleMemoryPin,
    forgetMemory,
    addChatMemory,
    approveMemory,
    refreshMemories,
    correctMemory,
    toggleMemoryRecordDisabled,
    toggleMemoryDisabled,
    exportMemory,
    assembleConversationContext,
    backendProviders,
    connectedBackendIds,
    backendStatus,
    onboardingRequired,
    connectBackend,
    connectBackendWithVerify,
    checkBackendConnection,
    startBackendBrowserLogin,
    disconnectBackend,
    refreshBackendProviders,
    modelDiscoveryByProvider,
    refreshModels,
    connectedAgentBackends,
    connectedAgentBackend,
    selectableModels,
    modelOptions,
    allModelOptions,
    hiddenModelIds,
    setModelVisible: (modelId: string, visible: boolean) => {
      if (!allModelOptions.some((model) => model.id === modelId)) return;
      setHiddenModelIds((current) =>
        visible
          ? current.filter((id) => id !== modelId)
          : [...new Set([...current, modelId])],
      );
    },
    resolvedSelectedModelId,
    resolvedModelOptionId,
    selectedModelId,
    selectModel,
    permissionMode,
    permissionLabel,
    selectPermissionLabel,
    customApprovalSettings,
    updateCustomApprovalSetting,
    lastAction,

    setLastAction,
  };
}

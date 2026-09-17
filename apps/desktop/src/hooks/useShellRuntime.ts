import {
  importLocalTextFile,
  normalizeCustomApprovalSettings,
  resolvePermissionModeFromCustom,
  type LocalTextFileCandidate,
} from "@mivlet/connectors";
import {
  assembleContext,
  chunkSourceText,
  exportMemories,
  isLiveMemory,
  isLiveSource,
  retrieve,
} from "@mivlet/knowledge";
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
  PreparedExecutionContext,
} from "@mivlet/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isApprovalPresetLabel,
  knowledgeScopeForRun,
  permissionLabelFor,
  permissionModeFor,
  privateRunAudience,
  recordsVisibleToRunAudience,
  selectMemoryForRun,
  sourceAllowedByConnections,
  withPreviewPrivateAuthority,
  type KnowledgeRunContext,
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
  changeRuntimeMemoryRecord,
  correctRuntimeMemoryRecord,
  exportRuntimeMemoryState,
  importRuntimeLocalKnowledgeSource,
  listRuntimeContextSummaries,
  loadRuntimeImportedKnowledgeSources,
  loadRuntimeMemoryState,
  saveRuntimeMemoryState,
} from "../runtime/domains/memory";

import { isMivletProviderEnabled } from "../lib/provider-availability";
import { isSupportedConnectorId } from "./shell-runtime/backend-normalization";
import { defaultShellState } from "./shell-runtime/defaults";
import type {
  ShellRuntime,
  UseShellRuntimeOptions,
} from "./shell-runtime/types";

export type {
  ShellRuntime,
  UseShellRuntimeOptions,
} from "./shell-runtime/types";

function createExecutionAttemptId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `run-${uuid}`;
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

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
      setOnboardingVersion(0);
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
          .filter((manifest) => manifest.status === "connected")
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

  const connectionIsAuthorized = (
    connectorId: string,
    _account?: string,
    connectionId?: string,
  ) => {
    if (connectorId === "local-files") return true;
    if (!connectionId) return false;
    if (!hasTauriRuntime()) return false;
    const connection = connectorAccounts[connectorId]?.find(
      (candidate) => candidate.connectionId === connectionId,
    );
    return Boolean(
      connection &&
      connection.lifecycle === "authorized" &&
      connection.authorizationState === "authorized" &&
      connection.credentialState === "available" &&
      connection.healthState !== "unhealthy" &&
      connection.healthState !== "offline",
    );
  };

  const sourceIsAuthorized = (source: KnowledgeSource) => {
    if (
      source.disabled ||
      source.deletedAt ||
      source.status === "stale" ||
      source.status === "error"
    )
      return false;
    return connectionIsAuthorized(
      source.connectorId,
      source.account,
      source.connectionId,
    );
  };

  const knowledgeRetrievalSources = (
    sources: readonly KnowledgeSource[] = workspaceKnowledgeSources,
    context?: KnowledgeRunContext,
  ) =>
    sources
      // Only live (non-disabled), authorized, connected-connector sources can
      // enter retrieval. Stale/error statuses are additionally excluded by the
      // retrieval filter; we re-check live here so a
      // disabled source is never even chunked.
      .filter(
        (source) =>
          isLiveSource(source) &&
          sourceIsAuthorized(source) &&
          sourceAllowedByConnections(source, context) &&
          (!context?.allowedConnectorIds ||
            source.connectorId === "local-files" ||
            context.allowedConnectorIds.includes(source.connectorId)) &&
          (!context?.allowedKnowledgeSourceIds ||
            context.allowedKnowledgeSourceIds.includes(source.id)),
      )
      .map((source) => ({
        source,
        chunks: chunkSourceText(source.contentPreview ?? "", {
          sourceId: source.id,
          mimeType: source.providerMetadata?.mimeType,
        }),
      }))
      .filter((record) => record.chunks.length > 0);

  const assembleConversationContext = async (
    query: string,
    context?: KnowledgeRunContext,
  ): Promise<PreparedExecutionContext> => {
    const attemptId = createExecutionAttemptId();
    const assembledAt = new Date().toISOString();
    const scope = knowledgeScopeForRun(context?.threadId);
    const audience = privateRunAudience(accountWorkspaceStatus);
    const selectedMemory = selectMemoryForRun(managedMemoryRecords);
    // Native records must already carry canonical ownership from migration.
    // Browser preview has no native store, so its deliberate fixtures receive
    // explicit private ownership before the same fail-closed filter is applied.
    const governedSources = hasTauriRuntime()
      ? workspaceKnowledgeSources
      : withPreviewPrivateAuthority(workspaceKnowledgeSources, audience);
    const governedMemory = hasTauriRuntime()
      ? selectedMemory
      : withPreviewPrivateAuthority(selectedMemory, audience);
    const visibleSources = recordsVisibleToRunAudience(
      governedSources,
      audience,
    );
    const visibleMemory = recordsVisibleToRunAudience(governedMemory, audience);
    // Durable derived summaries for this exact conversation. They are account-
    // scoped natively and only enter the prefix as untrusted prior evidence.
    const summaries =
      hasTauriRuntime() && context?.threadId
        ? ((await listRuntimeContextSummaries(context.threadId)) ?? [])
        : [];
    const result = await retrieve(
      knowledgeRetrievalSources(visibleSources, context),
      {
        query,
        scope,
        audience,
        limit: 8,
        budgetChars: 6_000,
      },
    );
    const assembled = assembleContext({
      attemptId,
      assembledAt,
      scope,
      audience,
      // Only live memories enter context: forgotten/disabled records are
      // excluded by isLiveMemory. Memory-disabled (the workspace-level kill
      // switch) excludes everything.
      memory:
        memoryDisabled || context?.excludePrivateMemory ? [] : visibleMemory,
      summaries,
      citations: result.citations,
      authorization: {
        isSourceAuthorized: connectionIsAuthorized,
      },
    });
    return Object.freeze({
      systemPrefix: assembled.systemPrefix,
      receipt: assembled.receipt,
    });
  };

  const commitMemoryState = (state: MemoryControlState, status: string) => {
    // Capture the pre-change state so a native save failure rolls back the
    // optimistic update instead of leaving a phantom record in the UI.
    const previousDisabled = memoryDisabled;
    const previousRecords = managedMemoryRecords;
    const generation = connectorScopeRef.current;
    setMemoryDisabled(state.disabled);
    setManagedMemoryRecords(
      state.records.filter((record) => !record.forgottenAt),
    );
    setMemoryStatus("Saving memory…");

    return saveRuntimeMemoryState(state)
      .then((runtimeState) => {
        if (!runtimeState || connectorScopeRef.current !== generation) {
          return;
        }

        setMemoryDisabled(runtimeState.disabled);
        setManagedMemoryRecords(runtimeState.records);
        setMemoryStatus(status);
      })
      .catch(async (error) => {
        const current = await loadRuntimeMemoryState().catch(() => null);
        if (connectorScopeRef.current !== generation) return;
        // A concurrent correction may be newer than this optimistic snapshot.
        setMemoryDisabled(current?.disabled ?? previousDisabled);
        setManagedMemoryRecords(current?.records ?? previousRecords);
        setMemoryStatus(
          error instanceof Error
            ? error.message
            : "Mivlet could not save memory state.",
        );
      });
  };

  const changeMemory = async (
    recordId: string,
    change: "enabled" | "disabled" | "forgotten",
  ) => {
    const record = managedMemoryRecords.find(
      (item) => item.id === recordId && !item.forgottenAt,
    );
    if (!record) throw new Error("That memory is no longer available.");
    const generation = connectorScopeRef.current;
    const state = await changeRuntimeMemoryRecord({
      id: recordId,
      state: change,
      expectedUpdatedAt: record.updatedAt,
    });
    if (connectorScopeRef.current !== generation) return;
    setMemoryDisabled(state.disabled);
    setManagedMemoryRecords(state.records);
    setMemoryStatus(
      change === "forgotten"
        ? "Memory forgotten."
        : change === "disabled"
          ? "Memory disabled."
          : "Memory enabled.",
    );
  };
  const forgetMemory = (recordId: string) =>
    changeMemory(recordId, "forgotten");

  const correctMemory = async (
    recordId: string,
    title: string,
    value: string,
    expectedUpdatedAt?: string,
  ) => {
    const generation = connectorScopeRef.current;
    const state = await correctRuntimeMemoryRecord({
      id: recordId,
      title,
      value,
      expectedUpdatedAt,
    });
    if (connectorScopeRef.current !== generation) return;
    setMemoryDisabled(state.disabled);
    setManagedMemoryRecords(state.records);
    setMemoryStatus("Memory corrected.");
  };

  /**
   * Toggle a single memory's disabled state. A disabled memory is excluded from
   * retrieval, context, and export (like a forgotten one) but stays visible in
   * the management view and can be re-enabled — no record duplication. Pinning
   * is dropped while disabled so it cannot bypass the exclusion via pinned
   * context.
   */
  const toggleMemoryRecordDisabled = (recordId: string) =>
    changeMemory(
      recordId,
      managedMemoryRecords.find((record) => record.id === recordId)?.disabled
        ? "enabled"
        : "disabled",
    );

  const toggleMemoryPin = (recordId: string) => {
    const target = managedMemoryRecords.find(
      (record) => record.id === recordId,
    );
    if (!target) return;
    // Pinning must not bypass exclusion: a disabled or forgotten memory cannot
    // be pinned. Unpinning a currently-pinned record is always allowed so a
    // stale pin can be cleared.
    if (!target.pinned && !isLiveMemory(target)) {
      setMemoryStatus("Disabled or forgotten memories cannot be pinned.");
      return;
    }
    const nextRecords = managedMemoryRecords.map((record) =>
      record.id === recordId ? { ...record, pinned: !record.pinned } : record,
    );
    const changed = nextRecords.find((record) => record.id === recordId);
    commitMemoryState(
      { disabled: memoryDisabled, records: nextRecords },
      changed?.pinned ? "Memory pinned." : "Memory unpinned.",
    );
  };

  const toggleMemoryDisabled = () => {
    return commitMemoryState(
      { disabled: !memoryDisabled, records: managedMemoryRecords },
      memoryDisabled ? "Memory enabled." : "Memory disabled.",
    );
  };

  const exportMemory = async () => {
    try {
      // Live memories only: forgotten/disabled records are excluded by
      // `exportMemories`. The native export is authoritative when present; the
      // fallback re-applies the same live-only filter so secrets never ride
      // along on a forgotten record's payload and disabled records never leak.
      const liveFallback = exportMemories(memoryState.records);
      const exported =
        (await exportRuntimeMemoryState(memoryState)) ?? liveFallback;
      setMemoryExportText(exported);
      setMemoryStatus("Memory export ready.");
    } catch (error) {
      setMemoryStatus(
        error instanceof Error
          ? error.message
          : "Mivlet could not export memory.",
      );
    }
  };

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

  const createAgent = (input: Omit<MivletAgentProfile, "id" | "threadId">) => {
    const id = `agent-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
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

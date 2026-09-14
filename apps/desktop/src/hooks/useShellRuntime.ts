import { listVerifiedConnectorStatuses as listRuntimeConnectorStatuses } from "../lib/load-connector-connections";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CONNECTOR_CONNECTIONS_CHANGED } from "../lib/connector-connections";
import type {
  ActionHistoryEvent,
  ApprovalAuditEntry,
  ApprovalDecision,
  ApprovalGrant,
  ApprovalModification,
  ApprovalRequest,
  BackendProvider,
  BackendVerifyOutcome,
  BackendVerifyResult,
  ConnectorAccountOption,
  ConnectorManifest,
  CustomApprovalSettings,
  FableAgentProfile,
  KnowledgeSource,
  LocalFileImport,
  MemoryControlState,
  MemoryRecord,
  PermissionMode,
  PreparedExecutionContext,
  RuntimeSnapshot,
  IdentityStatus,
  AccountWorkspaceStatus,
} from "@fable/protocol";
import {
  assembleContext,
  chunkSourceText,
  exportMemories,
  isLiveMemory,
  isLiveSource,
  retrieve,
} from "@fable/knowledge";
import {
  hasRunnableAdapter,
  importLocalTextFile,
  listBackendProviders,
  mergeDiscoveredModels,
  resolveCapabilities,
  normalizeCustomApprovalSettings,
  resolvePermissionModeFromCustom,
  type ToolApprovalGate,
  type ModelDiscoveryResult,
  type LocalTextFileCandidate,
} from "@fable/connectors";
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
import {
  modelsForProvider,
  providerModelOptions,
  resolveProviderModelOption,
} from "../lib/provider-models";
import {
  connectors,
  knowledgeSources,
} from "../data/workspace";
import {
  beginRuntimeConnectorOAuth,
  beginRuntimeIdentitySignIn,
  beginRuntimeIdentityRecovery,
  clearRuntimeConnectorAuth,
  clearRuntimeBackend,
  connectRuntimeBackend,
  exportRuntimeMemoryState,
  correctRuntimeMemoryRecord,
  changeRuntimeMemoryRecord,
  importRuntimeLocalKnowledgeSource,
  listRuntimeConnectorSyncStates,
  listRuntimeConnectorAccounts,
  listRuntimeConnectorKnowledgeSources,
  listRuntimeBackends,
  listRuntimeBackendModels,
  loadRuntimeActionHistory,
  loadRuntimeApprovalAudit,
  loadRuntimeApprovalRules,
  loadRuntimeImportedKnowledgeSources,
  loadRuntimeMemoryState,
  listRuntimeContextSummaries,
  loadRuntimeSnapshot,
  loadRuntimeIdentityStatus,
  loadRuntimeAccountWorkspaceStatus,
  reconcileRuntimeAccountWorkspace,
  clearRuntimeAccountWorkspaceSession,
  refreshRuntimeConnectorHealth,
  resolveRuntimeApprovalRequest,
  saveRuntimeMemoryState,
  saveRuntimeSnapshot,
  switchRuntimeConnectorAccount,
  syncRuntimeConnector,
  refreshRuntimeIdentity,
  signOutRuntimeIdentity,
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
} from "../runtime";
import {
  clearActiveRuntimeDataScope,
  setActiveRuntimeDataScope,
} from "../runtime-scope";
import {
  MAX_IMPORTED_KNOWLEDGE_SOURCES,
} from "../lib/constants";
import {
  EMPTY_APPROVAL_MODIFICATION,
  type ApprovalModificationDraft,
  type PendingApprovalConfirmation,
  type PersistedShellState,
} from "../lib/types";
import {
  mergeKnowledgeSources,
  prependAuditEntry,
  readFileAsText,
} from "../lib/helpers";
import {
  resolveApprovalFallback,
} from "../lib/approval-fallbacks";
import {
  hasTauriRuntime,
  persistShellState,
  readPersistedShellState,
  shellStateFromRuntimeSnapshot,
  shellStateToRuntimeSnapshot,
} from "../lib/persistence";
import type {
  ModelDiscoveryOutcome,
} from "../lib/backend-state";
import {
  enabledFableProviders,
  isFableProviderEnabled,
} from "../lib/provider-availability";
import {
  CURRENT_ONBOARDING_VERSION,
  DEFAULT_ACCOUNT_WORKSPACE_STATUS,
  DEFAULT_IDENTITY_STATUS,
  PREVIEW_ACCOUNT_WORKSPACE_STATUS,
  PREVIEW_IDENTITY_STATUS,
  defaultShellState,
  runtimeOrPreview,
} from "./shell-runtime/defaults";
import {
  isSupportedConnectorId,
} from "./shell-runtime/backend-normalization";
import type {
  ShellRuntime,
  UseShellRuntimeOptions,
} from "./shell-runtime/types";

export type {
  ShellRuntime,
  UseShellRuntimeOptions,
} from "./shell-runtime/types";

/**
 * Owns all workspace shell state and the runtime-backed effects (snapshot
 * recovery, approval audit/rules, imported knowledge, memory). Returns the
 * state and callbacks the root component needs to render workspace settings
 * and context views.
 */

function createExecutionAttemptId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `run-${uuid}`;
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

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

export function useShellRuntime(
  options: UseShellRuntimeOptions = {},
): ShellRuntime {
  const approvalGateRef = useRef<ToolApprovalGate | null>(
    options.approvalGate ?? null,
  );
  approvalGateRef.current = options.approvalGate ?? null;
  const scopeResetRef = useRef(options.onScopeReset);
  scopeResetRef.current = options.onScopeReset;
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
  const [voiceProvider, setVoiceProvider] = useState<"browser" | "openai">(initialState.voiceProvider === "openai" ? "openai" : "browser");

  const [lastAction, setLastAction] = useState("Workspace ready");
  const [identityStatus, setIdentityStatus] = useState<IdentityStatus>(() =>
    hasTauriRuntime() ? DEFAULT_IDENTITY_STATUS : PREVIEW_IDENTITY_STATUS,
  );
  const [identityPending, setIdentityPending] = useState(false);
  const [accountWorkspaceStatus, setAccountWorkspaceStatus] =
    useState<AccountWorkspaceStatus>(() =>
      hasTauriRuntime()
        ? DEFAULT_ACCOUNT_WORKSPACE_STATUS
        : PREVIEW_ACCOUNT_WORKSPACE_STATUS,
    );
  const [accountWorkspacePending, setAccountWorkspacePending] =
    useState(hasTauriRuntime());
  const accountWorkspaceFallback = hasTauriRuntime()
    ? DEFAULT_ACCOUNT_WORKSPACE_STATUS
    : PREVIEW_ACCOUNT_WORKSPACE_STATUS;
  const [workspaceScopeGeneration, setWorkspaceScopeGeneration] = useState(0);
  const workspaceIdentityRef = useRef<string | null>(null);
  const hydratedWorkspaceRef = useRef<string | null>(null);
  const snapshotLoadFailedRef = useRef(false);
  const accountRequestGenerationRef = useRef(0);
  const activeWorkspaceScope =
    accountWorkspaceStatus.accountBound &&
    (accountWorkspaceStatus.state === "ready" ||
      accountWorkspaceStatus.state === "offline")
      ? { workspaceId: accountWorkspaceStatus.activeWorkspace.localWorkspaceId }
      : null;
  const [approvalAudit, setApprovalAudit] = useState<ApprovalAuditEntry[]>(
    initialState.approvalAudit,
  );
  const [approvalPreviews, setApprovalPreviews] = useState<Record<string, { summary: string; details: string }>>({});
  const [backendToolApprovals, setBackendToolApprovals] = useState<
    ApprovalRequest[]
  >([]);
  const [actionHistory, setActionHistory] = useState<ActionHistoryEvent[]>([]);
  const [dismissedApprovalIds, setDismissedApprovalIds] = useState<string[]>(
    initialState.dismissedApprovalIds,
  );
  const [approvalRules, setApprovalRules] = useState<ApprovalGrant[]>(
    initialState.approvalRules,
  );
  const [sessionApprovalGrants, setSessionApprovalGrants] = useState<
    ApprovalGrant[]
  >([]);
  const [editingApprovalId, setEditingApprovalId] = useState<string | null>(
    null,
  );
  const [approvalModificationDraft, setApprovalModificationDraft] =
    useState<ApprovalModificationDraft>(EMPTY_APPROVAL_MODIFICATION);
  const [pendingApprovalConfirmation, setPendingApprovalConfirmation] =
    useState<PendingApprovalConfirmation | null>(null);
  const [approvalConfirmationText, setApprovalConfirmationText] = useState("");
  const [agents, setAgents] = useState<FableAgentProfile[]>(
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
  const [connectedBackendIds, setConnectedBackendIds] = useState<string[]>(
    hasTauriRuntime()
      ? []
      : initialState.connectedBackendIds.filter(isFableProviderEnabled),
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
      setConnectorManifests((current) => latest.map((manifest) => {
        const previous = current.find((candidate) => candidate.id === manifest.id);
        return previous?.sync ? { ...manifest, sync: previous.sync } : manifest;
      }));
    }
    return latest;
  }, []);
  useEffect(() => {
    const refresh = () => { void refreshConnectorStatuses().catch(() => undefined); };
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
  const connectorApprovalRequests = useRef(new Map<string, ApprovalRequest>());
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
  const [runtimeSnapshotReady, setRuntimeSnapshotReady] = useState(false);
  const [runtimeSnapshotError, setRuntimeSnapshotError] = useState<string | null>(null);

  // Agent-runtime backends. The Rust credential boundary resolves auth state
  // + capabilities; outside Tauri the preview registry is used so the onboarding
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
  const [onboardingDismissed, setOnboardingDismissed] = useState(
    initialState.onboardingComplete ?? false,
  );
  const [onboardingVersion, setOnboardingVersion] = useState(
    initialState.onboardingVersion ?? 0,
  );
  const [backendStatus, setBackendStatus] = useState<string | null>(null);
  // Composer model + permission picker selections, persisted so the next run
  // uses them. The model is re-validated against the connected backend's
  // available models before each run (see resolveSelectedModel).
  const [selectedModelId, setSelectedModelId] = useState(
    initialState.selectedModelId,
  );
  const [hiddenModelIds, setHiddenModelIds] = useState<string[]>(initialState.hiddenModelIds ?? []);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    initialState.permissionMode,
  );
  const permissionModeRef = useRef(permissionMode);
  permissionModeRef.current = permissionMode;
  const [permissionLabel, setPermissionLabel] = useState(
    isApprovalPresetLabel(initialState.permissionLabel)
      ? initialState.permissionLabel
      : permissionLabelFor(initialState.permissionMode),
  );
  const [customApprovalSettings, setCustomApprovalSettings] =
    useState<CustomApprovalSettings>(
      normalizeCustomApprovalSettings(initialState.customApprovalSettings),
    );

  const workspaceKnowledgeSources = useMemo(
    () =>
      mergeKnowledgeSources(hasTauriRuntime() ? [] : knowledgeSources, [
        ...connectorImportedSources,
        ...importedKnowledgeSources,
      ]).filter((source) => !source.deletedAt),
    [connectorImportedSources, importedKnowledgeSources],
  );
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
  const openApprovals = useMemo(
    () =>
      backendToolApprovals.filter(
        (approval) => !dismissedApprovalIds.includes(approval.id),
      ),
    [backendToolApprovals, dismissedApprovalIds],
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

  // Coalesce account and settings changes into one trailing native write.
  // Conversation drafts have their own scoped writer and never enter this snapshot.
  const shellStateRef = useRef(shellState);
  shellStateRef.current = shellState;
  // Track whether a debounced localStorage write is still pending so an unmount
  // flush can guarantee the final settings land in storage. Rapid changes reset
  // the timer; only the trailing write fires.
  const persistTimerRef = useRef<number | null>(null);
  const snapshotTimerRef = useRef<number | null>(null);
  const pendingSnapshotRef = useRef<{ identity: string; workspaceId: string; snapshot: RuntimeSnapshot } | null>(null);
  const snapshotWrites = useRef<Promise<unknown>>(Promise.resolve());
  const writeSnapshot = (snapshot: RuntimeSnapshot, workspaceId: string) => {
    const identity = workspaceIdentityRef.current;
    const next = snapshotWrites.current.catch(() => undefined).then(() => {
      if (!identity || workspaceIdentityRef.current !== identity) throw new Error("The workspace changed before its settings could be saved.");
      return saveRuntimeSnapshot(snapshot, workspaceId);
    });
    snapshotWrites.current = next;
    return next;
  };
  const flushSnapshot = async () => {
    const identity = workspaceIdentityRef.current;
    if (!runtimeSnapshotReady || !activeWorkspaceScope || !identity || hydratedWorkspaceRef.current !== identity) throw new Error("Wait for workspace settings to load.");
    if (snapshotTimerRef.current !== null) window.clearTimeout(snapshotTimerRef.current);
    snapshotTimerRef.current = null;
    pendingSnapshotRef.current = null;
    await writeSnapshot(shellStateToRuntimeSnapshot(shellStateRef.current), activeWorkspaceScope.workspaceId);
  };

  useEffect(() => {
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      persistShellState(shellStateRef.current);
    }, 300);
  }, [shellState]);

  // Flush any pending localStorage write on unmount so the final state persists.
  useEffect(() => {
    return () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
        persistShellState(shellStateRef.current);
      }
    };
  }, [workspaceScopeGeneration]);

  useEffect(() => {
    const identity = workspaceIdentityRef.current;
    if (!runtimeSnapshotReady || !activeWorkspaceScope || !identity || hydratedWorkspaceRef.current !== identity) {
      return;
    }

    // Debounced to coalesce rapid profile and workspace setting changes
    // into a single trailing snapshot save. Bind both the captured snapshot and
    // its owner/workspace so a later scope cannot receive this write.
    if (snapshotTimerRef.current !== null) {
      window.clearTimeout(snapshotTimerRef.current);
    }
    const pending = { identity, workspaceId: activeWorkspaceScope.workspaceId, snapshot: shellStateToRuntimeSnapshot(shellState) };
    pendingSnapshotRef.current = pending;
    snapshotTimerRef.current = window.setTimeout(() => {
      snapshotTimerRef.current = null;
      pendingSnapshotRef.current = null;
      if (workspaceIdentityRef.current !== pending.identity || hydratedWorkspaceRef.current !== pending.identity) return;
      void writeSnapshot(
        pending.snapshot, pending.workspaceId,
      ).catch((error) => {
        setLastAction(
          error instanceof Error
            ? error.message
            : "Mivlet could not save runtime snapshot.",
        );
      });
    }, 300);
  }, [activeWorkspaceScope?.workspaceId, runtimeSnapshotReady, shellState]);

  // Flush any pending snapshot save on unmount so the final state is captured.
  useEffect(() => {
    return () => {
      if (snapshotTimerRef.current !== null) {
        window.clearTimeout(snapshotTimerRef.current);
        snapshotTimerRef.current = null;
        const pending = pendingSnapshotRef.current;
        pendingSnapshotRef.current = null;
        if (pending && workspaceIdentityRef.current === pending.identity && hydratedWorkspaceRef.current === pending.identity) {
          void writeSnapshot(pending.snapshot, pending.workspaceId).catch(() => undefined);
        }
      }
    };
  }, [workspaceScopeGeneration]);

  useEffect(() => {
    let active = true;
    if (!activeWorkspaceScope) {
      approvalGateRef.current?.cancelPending();
      scopeResetRef.current?.();
      setBackendToolApprovals([]);
      hydratedWorkspaceRef.current = null;
      setRuntimeSnapshotReady(false);
      return () => {
        active = false;
      };
    }

    // Fast Refresh may replay effects while preserving the live gate and run.
    // A completed hydration of this exact owner/workspace needs no replay.
    const hydrationIdentity = workspaceIdentityRef.current;
    if (hasTauriRuntime() && hydrationIdentity === null) return;
    if (hydrationIdentity !== null && hydratedWorkspaceRef.current === hydrationIdentity) return;

    // A switch is a hard tenant boundary. Drop everything that can have been
    // loaded for the prior scope before any new asynchronous hydration lands.
    // Preview is an intentional in-memory fixture, so retain its seeded data.
    if (hasTauriRuntime()) {
      approvalGateRef.current?.cancelPending();
      scopeResetRef.current?.();
      setActiveItem(defaultShellState.activeItem);

      setRuntimeSnapshotReady(false);
      setApprovalAudit([]);
      setActionHistory([]);
      setApprovalRules([]);
      setBackendToolApprovals([]);
      setApprovalPreviews({});
      setDismissedApprovalIds([]);
      setSessionApprovalGrants([]);
      setEditingApprovalId(null);
      setPendingApprovalConfirmation(null);
      setApprovalConfirmationText("");
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
    }
    snapshotLoadFailedRef.current = false;
    setRuntimeSnapshotError(null);
    void loadRuntimeSnapshot(activeWorkspaceScope.workspaceId)
      .then((snapshot: RuntimeSnapshot | null) => {
        if (!active) {
          return;
        }
        hydratedWorkspaceRef.current = hydrationIdentity;
        setRuntimeSnapshotReady(true);
        if (!snapshot) return;

        const recovered = shellStateFromRuntimeSnapshot(
          snapshot,
          defaultShellState,
        );
        setActiveItem(recovered.activeItem);

        setVoiceEnabled(recovered.voiceEnabled);
        setVoiceProvider(recovered.voiceProvider === "openai" ? "openai" : "browser");
        setApprovalAudit(recovered.approvalAudit);
        setDismissedApprovalIds(recovered.dismissedApprovalIds);
        setApprovalRules(recovered.approvalRules);
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
            recovered.connectedBackendIds.filter(isFableProviderEnabled),
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
        setLastAction("Recovered workspace from local runtime");
      })
      .catch((error) => {
        if (active) {
          hydratedWorkspaceRef.current = null;
          snapshotLoadFailedRef.current = true;
          setRuntimeSnapshotReady(false);
          const message = error instanceof Error ? error.message : "Mivlet could not load the saved workspace.";
          setRuntimeSnapshotError(message);
          setLastAction(message);
        }
      });

    return () => {
      active = false;
    };
  }, [workspaceScopeGeneration]);

  useEffect(() => {
    let active = true;

    void loadRuntimeApprovalAudit().then((entries) => {
      if (!active || !entries || entries.length === 0) {
        return;
      }

      setApprovalAudit(entries.slice(0, 200));
    });

    return () => {
      active = false;
    };
  }, [workspaceScopeGeneration]);

  const refreshActionHistory = useCallback(() => {
    void loadRuntimeActionHistory().then((events) => {
      if (events && Array.isArray(events)) {
        setActionHistory(events.slice(0, 200));
      }
    });
  }, [workspaceScopeGeneration]);

  useEffect(() => {
    refreshActionHistory();
  }, [refreshActionHistory]);

  const applyAccountWorkspaceStatus = useCallback(
    (status: AccountWorkspaceStatus) => {
      const canUseWorkspace =
        status.accountBound &&
        (status.state === "ready" || status.state === "offline") &&
        status.activeWorkspace.localWorkspaceId.length > 0;
      const identity = canUseWorkspace ? JSON.stringify([
        status.activeWorkspace.localWorkspaceId,
        status.activeContextOwner?.internalUserId ?? "",
        status.activeContextOwner?.memberId ?? "",
      ]) : null;
      const changed = workspaceIdentityRef.current !== identity;
      if (changed) {
        // Settle old promises before dropping the visible queue or changing the
        // active native data scope. Historical requests never become permits.
        approvalGateRef.current?.cancelPending();
        scopeResetRef.current?.();
        workspaceIdentityRef.current = identity;
        hydratedWorkspaceRef.current = null;
        if (snapshotTimerRef.current !== null) {
          window.clearTimeout(snapshotTimerRef.current);
          snapshotTimerRef.current = null;
        }
        pendingSnapshotRef.current = null;
      }
      if (canUseWorkspace) {
        setActiveRuntimeDataScope(status.activeWorkspace.localWorkspaceId);
      } else {
        clearActiveRuntimeDataScope();
      }
      setAccountWorkspaceStatus(status);
      if (changed || snapshotLoadFailedRef.current) setWorkspaceScopeGeneration((current) => current + 1);
    },
    [],
  );

  const refreshAccountWorkspace = useCallback(
    async (reconcile = false) => {
      const requestGeneration = ++accountRequestGenerationRef.current;
      setAccountWorkspacePending(true);
      try {
        const status = reconcile
          ? await reconcileRuntimeAccountWorkspace()
          : await loadRuntimeAccountWorkspaceStatus();
        if (requestGeneration !== accountRequestGenerationRef.current) {
          return status ?? accountWorkspaceFallback;
        }
        applyAccountWorkspaceStatus(status ?? accountWorkspaceFallback);
        return status ?? accountWorkspaceFallback;
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Mivlet could not load account workspaces.";
        let localFallback = accountWorkspaceFallback;
        if (hasTauriRuntime()) {
          try {
            // Hosted reconciliation is optional. If it fails, re-read the
            // native local status so the validated account owner survives;
            // the static boot fallback is not an authority-bearing identity.
            localFallback =
              (await loadRuntimeAccountWorkspaceStatus()) ?? localFallback;
          } catch {
            // Preserve the original reconciliation failure below.
          }
        }
        const failed: AccountWorkspaceStatus = {
          ...localFallback,
          message: localFallback.accountBound
            ? `Account workspace ready. Hosted refresh failed: ${message}`
            : `Account workspace unavailable: ${message}`,
        };
        if (requestGeneration === accountRequestGenerationRef.current) {
          applyAccountWorkspaceStatus(failed);
        }
        return failed;
      } finally {
        if (requestGeneration === accountRequestGenerationRef.current) {
          setAccountWorkspacePending(false);
        }
      }
    },
    [applyAccountWorkspaceStatus],
  );

  const refreshIdentityStatus = useCallback(async () => {
    const status = await loadRuntimeIdentityStatus();
    setIdentityStatus(
      status ??
        (hasTauriRuntime() ? DEFAULT_IDENTITY_STATUS : PREVIEW_IDENTITY_STATUS),
    );
  }, []);

  useEffect(() => {
    void refreshIdentityStatus();
  }, [refreshIdentityStatus]);

  useEffect(() => {
    if (hasTauriRuntime()) void refreshAccountWorkspace(false);
  }, [refreshAccountWorkspace]);

  const signInIdentity = useCallback(async () => {
    setIdentityPending(true);
    try {
      const status = await beginRuntimeIdentitySignIn();
      const next =
        status ??
        (hasTauriRuntime() ? DEFAULT_IDENTITY_STATUS : PREVIEW_IDENTITY_STATUS);
      setIdentityStatus(next);
      if (next.state === "signed-in") {
        await refreshAccountWorkspace(true);
      }
      setLastAction(next.message);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Mivlet cloud sign-in is unavailable.";
      setIdentityStatus((current) => ({
        ...current,
        state: current.enabled ? "error" : "disabled",
        message,
      }));
      setLastAction(message);
    } finally {
      setIdentityPending(false);
    }
  }, [refreshAccountWorkspace]);

  const recoverIdentity = useCallback(async () => {
    setIdentityPending(true);
    try {
      const status = await beginRuntimeIdentityRecovery();
      const next =
        status ??
        (hasTauriRuntime() ? DEFAULT_IDENTITY_STATUS : PREVIEW_IDENTITY_STATUS);
      setIdentityStatus(next);
      if (next.state === "signed-in") await refreshAccountWorkspace(true);
      setLastAction(next.message);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Mivlet account recovery is unavailable.";
      setLastAction(message);
    } finally {
      setIdentityPending(false);
    }
  }, [refreshAccountWorkspace]);

  const refreshIdentity = useCallback(async () => {
    setIdentityPending(true);
    try {
      const status = await refreshRuntimeIdentity();
      if (status) {
        setIdentityStatus(status);
        setLastAction(status.message);
        if (status.state === "signed-in") await refreshAccountWorkspace(true);
      } else {
        await refreshIdentityStatus();
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Mivlet cloud identity could not refresh.";
      setIdentityStatus((current) => ({
        ...current,
        state: current.enabled ? "error" : "disabled",
        message,
      }));
      setLastAction(message);
    } finally {
      setIdentityPending(false);
    }
  }, [refreshAccountWorkspace, refreshIdentityStatus]);

  const signOutIdentity = useCallback(async () => {
    ++accountRequestGenerationRef.current;
    setIdentityPending(true);
    try {
      const status = await signOutRuntimeIdentity();
      if (!status && hasTauriRuntime()) throw new Error("Mivlet could not confirm sign out. Try again.");
      await clearRuntimeAccountWorkspaceSession();
      applyAccountWorkspaceStatus({
        ...DEFAULT_ACCOUNT_WORKSPACE_STATUS,
        message:
          "Signed out of Mivlet. Your workspace is saved on this device.",
      });
      const next =
        status ??
        (hasTauriRuntime() ? DEFAULT_IDENTITY_STATUS : PREVIEW_IDENTITY_STATUS);
      setIdentityStatus(next);
      setLastAction(next.message);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Mivlet could not sign out.";
      setIdentityStatus((current) => ({
        ...current,
        state: current.enabled ? "error" : "disabled",
        message,
      }));
      setLastAction(message);
      throw new Error(message);
    } finally {
      setIdentityPending(false);
    }
  }, [applyAccountWorkspaceStatus]);

  const reconcileAccountWorkspace = useCallback(async () => {
    const status = await refreshAccountWorkspace(
      identityStatus.state === "signed-in",
    );
    setLastAction(status.message);
  }, [identityStatus.state, refreshAccountWorkspace]);

  useEffect(() => {
    let active = true;

    void loadRuntimeApprovalRules().then((rules) => {
      if (!active || !rules || rules.length === 0) {
        return;
      }

      setApprovalRules(rules);
    });

    return () => {
      active = false;
    };
  }, [workspaceScopeGeneration]);

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
      const content = decodedContent ?? await readFileAsText(file);
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
      memory: memoryDisabled || context?.excludePrivateMemory ? [] : visibleMemory,
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

  const changeMemory = async (recordId: string, change: "enabled" | "disabled" | "forgotten") => {
    const record = managedMemoryRecords.find((item) => item.id === recordId && !item.forgottenAt);
    if (!record) throw new Error("That memory is no longer available.");
    const generation = connectorScopeRef.current;
    const state = await changeRuntimeMemoryRecord({ id: recordId, state: change, expectedUpdatedAt: record.updatedAt });
    if (connectorScopeRef.current !== generation) return;
    setMemoryDisabled(state.disabled);
    setManagedMemoryRecords(state.records);
    setMemoryStatus(change === "forgotten" ? "Memory forgotten." : change === "disabled" ? "Memory disabled." : "Memory enabled.");
  };
  const forgetMemory = (recordId: string) => changeMemory(recordId, "forgotten");

  const correctMemory = async (recordId: string, title: string, value: string, expectedUpdatedAt?: string) => {
    const generation = connectorScopeRef.current;
    const state = await correctRuntimeMemoryRecord({ id: recordId, title, value, expectedUpdatedAt });
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
  const toggleMemoryRecordDisabled = (recordId: string) => changeMemory(recordId, managedMemoryRecords.find((record) => record.id === recordId)?.disabled ? "enabled" : "disabled");

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
        requestedScopes: connector.scopes?.map((scope) => scope.id),
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
        if (!refreshed || refreshed.status !== "connected" || refreshed.health?.state !== "healthy") {
          throw new Error(refreshed?.healthSummary ?? "Could not finish connecting. Try again.");
        }
        await loadConnectorAccounts(connector.id);
      } else {
        throw new Error(result.message || "Sign-in did not finish. Try again.");
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
    })().finally(() => { connectorOperations.current.delete(key); });
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
        throw new Error(`${connector.name} connections require the installed desktop app.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : `${connector.name} could not be disconnected.`;
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
        `${providerId} could not be verified. Retry before entering Mivlet.`;
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

  const dismissOnboarding = () => {
    const accountReady =
      identityStatus.state === "signed-in" ||
      (identityStatus.state === "offline" &&
        Boolean(identityStatus.authentication));
    if (!accountReady) {
      const message = "Sign in to Mivlet before finishing setup.";
      setIdentityStatus((current) => ({ ...current, message }));
      setLastAction(message);
      return;
    }
    if (!activeWorkspaceScope || connectedBackendIds.length === 0) {
      const message =
        "Connect and verify a model provider before entering Mivlet.";
      setBackendStatus(message);
      setLastAction(message);
      return;
    }
    setOnboardingDismissed(true);
    setOnboardingVersion(CURRENT_ONBOARDING_VERSION);
    setLastAction("Mivlet setup complete");
  };

  // Full access makes the decision automatically, through the same persisted
  // single-use authorization boundary. Other modes retain the interactive queue.
  const recordBackendToolCall = (event: {
    allowAutomatic?: boolean;
    callId: string;
    tool: string;
    arguments: string;
    approval: ApprovalRequest;
  }) => {
    if (event.tool === "connector-action" || event.tool === "connector-call") {
      connectorApprovalRequests.current.set(event.approval.id, event.approval);
    }
    if (permissionModeRef.current === "full-access" && event.allowAutomatic !== false) {
      void resolveApprovalDecision(event.approval, "once", undefined,
        event.approval.confirmationPhrase, true);
      return;
    }
    if (event.tool === "connector-action") {
      try {
        const context = JSON.parse(event.arguments) as { preview?: string; payload?: Record<string, string> };
        if (typeof context.preview === "string") setApprovalPreviews((current) => ({
          ...current, [event.approval.id]: { summary: context.preview as string, details: JSON.stringify(context.payload, null, 2) },
        }));
      } catch { /* Invalid previews never replace the exact native approval. */ }
    }
    setBackendToolApprovals((current) => {
      const existingIndex = current.findIndex(
        (approval) => approval.id === event.approval.id,
      );
      if (existingIndex < 0) return [...current, event.approval];
      return current.map((approval, index) =>
        index === existingIndex ? event.approval : approval,
      );
    });
    setLastAction(`Tool call from ${event.approval.service}: ${event.tool}`);
  };

  const clearBackendToolApprovals = (ids?: readonly string[]) => {
    if (ids) {
      for (const id of ids) connectorApprovalRequests.current.delete(id);
      setBackendToolApprovals(current => current.filter(approval => !ids.includes(approval.id)));
      setApprovalPreviews(current => Object.fromEntries(Object.entries(current).filter(([id]) => !ids.includes(id))));
      return;
    }
    connectorApprovalRequests.current.clear();
    setBackendToolApprovals([]);
    setApprovalPreviews({});
  };

  // A usable workspace, a verified provider, and explicit completion of the
  // first-run journey are all required. Persisted preview/local dismissal can
  // never bypass a missing provider.
  const onboardingRequired =
    !(
      identityStatus.state === "signed-in" ||
      (identityStatus.state === "offline" &&
        Boolean(identityStatus.authentication))
    ) ||
    !activeWorkspaceScope ||
    connectedBackendIds.length === 0 ||
    !onboardingDismissed ||
    onboardingVersion < CURRENT_ONBOARDING_VERSION;

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

  const approvalNeedsConfirmation = (
    approval: ApprovalRequest,
    modification?: ApprovalModification,
  ) => {
    const mode = modification?.mode ?? approval.mode;
    return (
      mode === "full-access" ||
      approval.riskLevel === "high" ||
      approval.riskLevel === "critical"
    );
  };

  const clearApprovalInteraction = () => {
    setEditingApprovalId(null);
    setApprovalModificationDraft(EMPTY_APPROVAL_MODIFICATION);
    setPendingApprovalConfirmation(null);
    setApprovalConfirmationText("");
  };

  const resolveApprovalDecision = async (
    approval: ApprovalRequest,
    decision: ApprovalDecision,
    modification?: ApprovalModification,
    confirmationText?: string,
    automatic = false,
  ) => {
    const gate = approvalGateRef.current;
    const identity = workspaceIdentityRef.current;
    const request = {
      request: approval,
      decision,
      decidedAt: new Date().toISOString(),
      modification,
      confirmationText,
    };

    try {
      const response = runtimeOrPreview(
        await resolveRuntimeApprovalRequest(request),
        () => resolveApprovalFallback(request),
        "Approvals require the desktop runtime.",
      );

      // A permission change, cancellation, or workspace switch while native
      // persistence is pending must never release an obsolete tool call.
      if (automatic && (permissionModeRef.current !== "full-access"
        || identity !== workspaceIdentityRef.current
        || gate !== approvalGateRef.current || !gate?.hasPending(approval.id))) {
        gate?.resolveDeny(approval.id);
        return;
      }

      setApprovalAudit((current) =>
        prependAuditEntry(current, response.auditEntry),
      );
      if (response.dismissed) {
        setDismissedApprovalIds((current) =>
          current.includes(approval.id) ? current : [...current, approval.id],
        );
      }
      if (response.grant?.scope === "session") {
        setSessionApprovalGrants((current) => [
          response.grant as ApprovalGrant,
          ...current.filter((grant) => grant.id !== response.grant?.id),
        ]);
      }
      if (response.grant?.scope === "rule") {
        setApprovalRules((current) => [
          response.grant as ApprovalGrant,
          ...current.filter((grant) => grant.id !== response.grant?.id),
        ]);
      }

      // Grant -> execute bridge: drive the matching pending tool call on the
      // shared approval gate so the agent-loop executor proceeds (grant) or
      // refuses (deny). Only approvals the shell registered as pending tool
      // calls are dispatched — a regular connector approval with no pending
      // entry is a no-op here. A deny never executes the tool.
      if (gate?.hasPending(approval.id)) {
        if (decision === "deny") {
          gate.resolveDeny(approval.id);
        } else if (
          decision === "once" ||
          decision === "session" ||
          decision === "rule" ||
          decision === "modify"
        ) {
          gate.resolveGrant(approval.id);
        }
      }

      setBackendToolApprovals((current) =>
        current.filter((candidate) => candidate.id !== approval.id),
      );
      connectorApprovalRequests.current.delete(approval.id);

      clearApprovalInteraction();
      setLastAction(
        decision === "modify"
          ? `Modified approval for ${approval.service}`
          : `${decision} recorded for ${approval.service}`,
      );
    } catch (error) {
      if (automatic) gate?.resolveDeny(approval.id);
      setLastAction(
        error instanceof Error
          ? error.message
          : "Mivlet could not resolve that approval.",
      );
    }
  };

  const requestApprovalDecision = (
    approval: ApprovalRequest,
    decision: ApprovalDecision,
    modification?: ApprovalModification,
  ) => {
    // The visible Approve button confirms this exact queued connector operation.
    // Preserve the native single-use receipt without a second typing ceremony.
    const queued = connectorApprovalRequests.current.get(approval.id);
    if (decision === "once" && !modification && queued === approval
      && approvalGateRef.current?.hasPending(approval.id)) {
      void resolveApprovalDecision(approval, decision, undefined, approval.confirmationPhrase);
      return;
    }
    if (
      decision !== "deny" &&
      approvalNeedsConfirmation(approval, modification)
    ) {
      setPendingApprovalConfirmation({
        request: approval,
        decision,
        modification,
      });
      setApprovalConfirmationText("");
      return;
    }

    void resolveApprovalDecision(approval, decision, modification);
  };

  const startApprovalModify = (approval: ApprovalRequest) => {
    setPendingApprovalConfirmation(null);
    setApprovalConfirmationText("");
    setEditingApprovalId(approval.id);
    setApprovalModificationDraft({
      mode: approval.mode,
      dataUsed: approval.dataUsed.join(", "),
      consequence: approval.consequence,
    });
  };

  const saveApprovalModify = (approval: ApprovalRequest) => {
    const dataUsed = approvalModificationDraft.dataUsed
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean);
    const consequence = approvalModificationDraft.consequence.trim();

    if (dataUsed.length === 0 || !consequence) {
      setLastAction("Modified approvals need allowed data and a consequence.");
      return;
    }

    requestApprovalDecision(approval, "modify", {
      mode: approvalModificationDraft.mode,
      dataUsed,
      consequence,
    });
  };

  const confirmApprovalDecision = () => {
    if (!pendingApprovalConfirmation) {
      return;
    }

    void resolveApprovalDecision(
      pendingApprovalConfirmation.request,
      pendingApprovalConfirmation.decision,
      pendingApprovalConfirmation.modification,
      approvalConfirmationText,
    );
  };

  const createAgent = (input: Omit<FableAgentProfile, "id" | "threadId">) => {
    const id = `agent-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
    const created: FableAgentProfile = {
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
    patch: Partial<Omit<FableAgentProfile, "id">>,
  ) => {
    setAgents((current) =>
      current.map((agent) =>
        agent.id === agentId ? {
          ...agent,
          ...patch,
          threadIds: patch.threadIds ?? [...new Set([
            ...(agent.threadIds ?? []),
            ...(agent.threadId ? [agent.threadId] : []),
            ...(patch.threadId ? [patch.threadId] : []),
          ])],
        } : agent,
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
    activeItem,
    setActiveItem,

    agents,
    flushSnapshot,
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
    openApprovals,
    approvalAudit,
    actionHistory,
    refreshActionHistory,
    sessionApprovalGrants,
    approvalRules,
    editingApprovalId,
    approvalModificationDraft,
    pendingApprovalConfirmation,
    approvalConfirmationText,
    setApprovalModificationDraft,
    setApprovalConfirmationText,
    requestApprovalDecision,
    startApprovalModify,
    saveApprovalModify,
    confirmApprovalDecision,
    clearApprovalInteraction,
    workspaceKnowledgeSources,
    importKnowledgeFile: (file: File, decodedContent?: string) => importLocalKnowledgeFile(file, file.name, undefined, decodedContent),
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
      setHiddenModelIds((current) => visible ? current.filter((id) => id !== modelId) : [...new Set([...current, modelId])]);
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
    recordBackendToolCall,
    approvalPreviews,
    identityStatus,
    identityPending,
    accountWorkspaceStatus,
    runtimeSnapshotError,
    runtimeSnapshotReady,
    accountWorkspacePending,
    signInIdentity,
    recoverIdentity,
    refreshIdentity,
    signOutIdentity,
    reconcileAccountWorkspace,
    clearBackendToolApprovals,
    dismissOnboarding,
    lastAction,

    setLastAction,
  };
}

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  ConnectorActionKind,
  ConnectorActionRequest,
  ConnectorAccountOption,
  ConnectorManifest,
  ConnectorSearchItem,
  ConnectorSearchRequest,
  ConnectorSearchResult,
  CustomApprovalSettings,
  FableAgentProfile,
  KnowledgeCitation,
  KnowledgeSource,
  LocalFileImport,
  MemoryControlState,
  MemoryPromotionRequest,
  MemoryRecord,
  PermissionMode,
  PreparedExecutionContext,
  RuntimeSnapshot,
  ThreadSummary,
  IdentityStatus,
  AccountWorkspaceStatus,
  WorkspaceDirective
} from "@fable/protocol";
import {
  assembleContext,
  chunkSourceText,
  disableMemory as disableMemoryRecord,
  editMemory,
  exportMemories,
  forgetMemory as forgetMemoryRecord,
  isLiveMemory,
  isLiveSource,
  retrieve
} from "@fable/knowledge";
import {
  canUseBrowserSession,
  createFixtureBrowserSession,
  createUnavailableBrowserSession,
  deriveBrowserSessionFromConnectors,
  hasRunnableAdapter,
  importFixtureConnectorItem,
  importLocalTextFile,
  labelFixtureSearchResult,
  listBackendProviders,
  mergeDiscoveredModels,
  prepareFixtureConnectorAction,
  resolveBrowserSessionAction,
  searchFixtureConnector,
  SUPPORTED_LOCAL_FILE_EXTENSIONS,
  normalizeCustomApprovalSettings,
  resolvePermissionModeFromCustom,
  type ToolApprovalGate,
  type ModelDiscoveryResult,
  type LocalTextFileCandidate
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
  type KnowledgeRunContext
} from "../lib/agent-run";
import {
  modelsForProvider,
  providerModelOptions,
  resolveProviderModelOption
} from "../lib/provider-models";
import {
  chatThreads,
  connectors,
  knowledgeSources,
  pendingApprovals,
  workspaceDirectives
} from "../data/workspace";
import {
  beginRuntimeConnectorOAuth,
  beginRuntimeIdentitySignIn,
  beginRuntimeIdentityRecovery,
  clearRuntimeConnectorAuth,
  clearRuntimeBackend,
  connectRuntimeBackend,
  exportRuntimeMemoryState,
  deleteRuntimeConnectorKnowledgeSource,
  importRuntimeConnectorItem,
  importRuntimeLocalKnowledgeSource,
  listRuntimeConnectorStatuses,
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
  loadRuntimeSnapshot,
  loadRuntimeIdentityStatus,
  loadRuntimeAccountWorkspaceStatus,
  reconcileRuntimeAccountWorkspace,
  createRuntimeAccountWorkspace,
  selectRuntimeAccountWorkspace,
  revokeRuntimeAccountDevice,
  clearRuntimeAccountWorkspaceSession,
  executeRuntimeConnectorAction,
  prepareRuntimeConnectorAction,
  promoteRuntimeKnowledgeSourceToMemory,
  refreshRuntimeLocalKnowledgeSource,
  refreshRuntimeConnectorHealth,
  resolveRuntimeApprovalRequest,
  saveRuntimeMemoryState,
  saveRuntimeImportedKnowledgeSources,
  saveRuntimeSnapshot,
  searchRuntimeConnector,
  setRuntimeConnectorKnowledgeSourceDisabled,
  switchRuntimeConnectorAccount,
  syncRuntimeConnector,
  refreshRuntimeIdentity,
  signOutRuntimeIdentity,
  startRuntimeCodexBrowserLogin,
  verifyRuntimeBackend
} from "../runtime";
import { buildLocalKnowledgeRefreshRequest } from "../lib/local-knowledge-refresh";
import {
  clearActiveRuntimeDataScope,
  setActiveRuntimeDataScope
} from "../runtime-scope";
import { MAX_IMPORTED_KNOWLEDGE_SOURCES } from "../lib/constants";
import {
  EMPTY_APPROVAL_MODIFICATION,
  type WorkspacePage,
  type ApprovalModificationDraft,
  type PendingApprovalConfirmation,
  type PersistedShellState,
  type ComposerAttachment
} from "../lib/types";
import {
  importedSourceDirective,
  mergeKnowledgeSources,
  prependAuditEntry,
  readFileAsDataUrl,
  readFileAsText,
  toSlug
} from "../lib/helpers";
import {
  promoteKnowledgeSourceFallback,
  resolveApprovalFallback
} from "../lib/approval-fallbacks";
import {
  hasTauriRuntime,
  importLegacyShellStateOnce,
  persistShellState,
  readPersistedShellState,
  shellStateFromRuntimeSnapshot,
  shellStateToRuntimeSnapshot
} from "../lib/persistence";
import type { ModelDiscoveryOutcome } from "../lib/backend-state";
import {
  enabledFableProviders,
  isFableProviderEnabled
} from "../lib/provider-availability";
import {
  ALLOW_PREVIEW_FALLBACKS,
  CURRENT_ONBOARDING_VERSION,
  DEFAULT_ACCOUNT_WORKSPACE_STATUS,
  DEFAULT_IDENTITY_STATUS,
  PREVIEW_ACCOUNT_WORKSPACE_STATUS,
  PREVIEW_IDENTITY_STATUS,
  defaultShellState,
  runtimeOrPreview
} from "./shell-runtime/defaults";
import { isFirstWaveConnectorId } from "./shell-runtime/backend-normalization";
import { mergeAcpProbeResults } from "./shell-runtime/provider-probes";
import type { ShellRuntime, UseShellRuntimeOptions } from "./shell-runtime/types";

export type { ShellRuntime, UseShellRuntimeOptions } from "./shell-runtime/types";

/**
 * Owns all workspace shell state and the runtime-backed effects (snapshot
 * recovery, approval audit/rules, imported knowledge, memory). Returns the
 * state and callbacks the root component needs to render the shell, composer,
 * and context views.
 */

function createExecutionAttemptId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `run-${uuid}`;
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function resolveUsableBackendProviders(
  providers: BackendProvider[]
): Promise<BackendProvider[]> {
  const resolved = await mergeAcpProbeResults(enabledFableProviders(providers));
  const nativeVerification = new Map<string, BackendVerifyResult | null>();

  await Promise.all(
    resolved
      .filter(
        (provider) =>
          provider.backendType === "native-api" && provider.authState === "connected"
      )
      .map(async (provider) => {
        nativeVerification.set(provider.id, await verifyRuntimeBackend(provider.id));
      })
  );

  return resolved.map((provider) => {
    const verification = nativeVerification.get(provider.id);
    if (verification === undefined || verification?.outcome === "ready") {
      return provider;
    }
    const authState = verification?.outcome === "auth-failed" ? "needs-auth" : "unavailable";
    return {
      ...provider,
      authState,
      capabilities: [],
      models: provider.models.map((model) => ({ ...model, available: false })),
      installHint:
        verification?.message ??
        "Fable could not verify this saved provider. Check the connection and try again."
    };
  });
}

export function useShellRuntime(options: UseShellRuntimeOptions = {}): ShellRuntime {
  const approvalGateRef = useRef<ToolApprovalGate | null>(options.approvalGate ?? null);
  approvalGateRef.current = options.approvalGate ?? null;
  const initialState = useMemo(
    () =>
      // Desktop: the runtime snapshot is the source of truth; localStorage is
      // read once for a legacy import then never again. Preview: localStorage
      // remains the sole store.
      hasTauriRuntime()
        ? importLegacyShellStateOnce(defaultShellState)
        : readPersistedShellState(defaultShellState),
    []
  );
  const [activeItem, setActiveItem] = useState(initialState.activeItem);
  const [composerValue, setComposerValue] = useState(initialState.composerValue);
  const [voiceEnabled, setVoiceEnabled] = useState(initialState.voiceEnabled);
  const [toolPickerOpen, setToolPickerOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [lastAction, setLastAction] = useState("Workspace ready");
  const [identityStatus, setIdentityStatus] = useState<IdentityStatus>(() =>
    hasTauriRuntime() ? DEFAULT_IDENTITY_STATUS : PREVIEW_IDENTITY_STATUS
  );
  const [identityPending, setIdentityPending] = useState(false);
  const [accountWorkspaceStatus, setAccountWorkspaceStatus] = useState<AccountWorkspaceStatus>(
    () =>
      hasTauriRuntime()
        ? DEFAULT_ACCOUNT_WORKSPACE_STATUS
        : PREVIEW_ACCOUNT_WORKSPACE_STATUS
  );
  const [accountWorkspacePending, setAccountWorkspacePending] = useState(hasTauriRuntime());
  const accountWorkspaceFallback = hasTauriRuntime()
    ? DEFAULT_ACCOUNT_WORKSPACE_STATUS
    : PREVIEW_ACCOUNT_WORKSPACE_STATUS;
  const [workspaceScopeGeneration, setWorkspaceScopeGeneration] = useState(0);
  const accountRequestGenerationRef = useRef(0);
  const activeWorkspaceScope =
    accountWorkspaceStatus.accountBound &&
    (accountWorkspaceStatus.state === "ready" || accountWorkspaceStatus.state === "offline")
      ? { workspaceId: accountWorkspaceStatus.activeWorkspace.localWorkspaceId }
      : null;
  const [approvalAudit, setApprovalAudit] = useState<ApprovalAuditEntry[]>(initialState.approvalAudit);
  const [backendToolApprovals, setBackendToolApprovals] = useState<ApprovalRequest[]>([]);
  const [actionHistory, setActionHistory] = useState<ActionHistoryEvent[]>([]);
  const [dismissedApprovalIds, setDismissedApprovalIds] = useState<string[]>(initialState.dismissedApprovalIds);
  const [approvalRules, setApprovalRules] = useState<ApprovalGrant[]>(initialState.approvalRules);
  const [sessionApprovalGrants, setSessionApprovalGrants] = useState<ApprovalGrant[]>([]);
  const [editingApprovalId, setEditingApprovalId] = useState<string | null>(null);
  const [approvalModificationDraft, setApprovalModificationDraft] =
    useState<ApprovalModificationDraft>(EMPTY_APPROVAL_MODIFICATION);
  const [pendingApprovalConfirmation, setPendingApprovalConfirmation] =
    useState<PendingApprovalConfirmation | null>(null);
  const [approvalConfirmationText, setApprovalConfirmationText] = useState("");
  const [agents, setAgents] = useState<FableAgentProfile[]>(
    initialState.agents?.length ? initialState.agents : defaultShellState.agents ?? []
  );
  const [activeAgentId, setActiveAgentId] = useState(
    initialState.activeAgentId ?? initialState.agents?.[0]?.id ?? "chief-of-staff"
  );
  const [pinnedSourceIds, setPinnedSourceIds] = useState<string[]>(initialState.pinnedSourceIds);
  const [connectedBackendIds, setConnectedBackendIds] = useState<string[]>(
    hasTauriRuntime()
      ? []
      : initialState.connectedBackendIds.filter(isFableProviderEnabled)
  );
  const [importedKnowledgeSources, setImportedKnowledgeSources] = useState<LocalFileImport[]>(
    initialState.importedKnowledgeSources
  );
  const [knowledgeCitations, setKnowledgeCitations] = useState<KnowledgeCitation[]>([]);
  const [knowledgeSearchMode, setKnowledgeSearchMode] = useState("lexical-fallback");
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachment[]>([]);
  const [connectorManifests, setConnectorManifests] =
    useState<ConnectorManifest[]>(connectors);
  const [connectorAccounts, setConnectorAccounts] = useState<Record<string, ConnectorAccountOption[]>>({});
  const [connectorStatus, setConnectorStatus] = useState<string | null>(null);
  const [connectorSearchResult, setConnectorSearchResult] =
    useState<ConnectorSearchResult | null>(null);
  const [connectorImportedSources, setConnectorImportedSources] = useState<KnowledgeSource[]>([]);
  const [preparedConnectorActions, setPreparedConnectorActions] =
    useState<ConnectorActionRequest[]>([]);
  const browserSession = useMemo(() => {
    if (hasTauriRuntime()) {
      return deriveBrowserSessionFromConnectors(connectorManifests);
    }
    return ALLOW_PREVIEW_FALLBACKS
      ? createFixtureBrowserSession()
      : createUnavailableBrowserSession("Browser sessions require the desktop runtime.");
  }, [connectorManifests]);
  const [managedMemoryRecords, setManagedMemoryRecords] = useState<MemoryRecord[]>(
    initialState.memoryRecords
  );
  const [memoryDisabled, setMemoryDisabled] = useState(initialState.memoryDisabled);
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [editingMemoryDraft, setEditingMemoryDraft] = useState<Pick<MemoryRecord, "title" | "value">>({
    title: "",
    value: ""
  });
  const [memoryExportText, setMemoryExportText] = useState("");
  const [memoryStatus, setMemoryStatus] = useState("Memory ready");
  const [knowledgeExportText, setKnowledgeExportText] = useState("");
  const [runtimeSnapshotReady, setRuntimeSnapshotReady] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Agent-runtime backends. The Rust credential boundary resolves auth state
  // + capabilities; outside Tauri the preview registry is used so the onboarding
  // shell stays testable. Preview connections remain visibly synthetic, while
  // the same provider gate is enforced in preview and native builds.
  const [backendProviders, setBackendProviders] = useState<BackendProvider[]>(() =>
    enabledFableProviders(listBackendProviders())
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
    initialState.onboardingComplete ?? false
  );
  const [onboardingVersion, setOnboardingVersion] = useState(
    initialState.onboardingVersion ?? 0
  );
  const [backendStatus, setBackendStatus] = useState<string | null>(null);
  // Composer model + permission picker selections, persisted so the next run
  // uses them. The model is re-validated against the connected backend's
  // available models before each run (see resolveSelectedModel).
  const [selectedModelId, setSelectedModelId] = useState(initialState.selectedModelId);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(initialState.permissionMode);
  const [permissionLabel, setPermissionLabel] = useState(
    isApprovalPresetLabel(initialState.permissionLabel)
      ? initialState.permissionLabel
      : permissionLabelFor(initialState.permissionMode)
  );
  const [customApprovalSettings, setCustomApprovalSettings] =
    useState<CustomApprovalSettings>(
      normalizeCustomApprovalSettings(initialState.customApprovalSettings)
    );
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const allThreads = useMemo(() => chatThreads, []);
  const activeThread = allThreads.find((thread) => thread.id === activeItem);
  const activeUtility = activeItem === "Settings" ? "Settings" : undefined;
  const activePage: WorkspacePage | null =
    activeItem === "Profile" || activeItem === "Settings" ? activeItem : null;
  const isChatView = activePage === null;
  const workspaceKnowledgeSources = useMemo(
    () =>
      mergeKnowledgeSources(hasTauriRuntime() ? [] : knowledgeSources, [
        ...connectorImportedSources,
        ...importedKnowledgeSources
      ]).filter((source) => !source.deletedAt),
    [connectorImportedSources, importedKnowledgeSources]
  );
  // Every runnable connection participates in the model picker. Selection owns
  // routing: Fable no longer silently sends all prompts to the first connection.
  const connectedAgentBackends = useMemo(
    () =>
      backendProviders.filter(
        (provider) =>
          provider.authState === "connected" &&
          provider.capabilities.includes("streaming") &&
          hasRunnableAdapter(provider.backendType) &&
          (provider.backendType !== "codex-app-server" || hasTauriRuntime())
      ),
    [backendProviders]
  );
  const modelOptions = useMemo(
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
                  discovery.outcome === "success" || discovery.outcome === "empty"
              })
            : provider.models;
          return { provider, models };
        })
      ),
    [connectedAgentBackends, discoveredModels]
  );
  const resolvedModelOption = useMemo(
    () => resolveProviderModelOption(modelOptions, selectedModelId),
    [modelOptions, selectedModelId]
  );
  const connectedAgentBackend = useMemo(
    () =>
      connectedAgentBackends.find(
        (provider) => provider.id === resolvedModelOption?.providerId
      ) ?? connectedAgentBackends[0],
    [connectedAgentBackends, resolvedModelOption?.providerId]
  );
  const selectableModels = useMemo(
    () => modelsForProvider(modelOptions, connectedAgentBackend?.id),
    [modelOptions, connectedAgentBackend?.id]
  );
  const resolvedSelectedModelId = resolvedModelOption?.modelId ?? "";
  const resolvedModelOptionId = resolvedModelOption?.id ?? "";
  const contextualDirectives = useMemo(
    () => [
      ...importedKnowledgeSources.slice(0, 2).map(importedSourceDirective),
      ...workspaceDirectives
    ].slice(0, 4),
    [importedKnowledgeSources]
  );
  const openApprovals = useMemo(
    () =>
      [
        ...backendToolApprovals,
        ...preparedConnectorActions.map((request) => request.approval),
        ...pendingApprovals
      ].filter((approval) => !dismissedApprovalIds.includes(approval.id)),
    [backendToolApprovals, preparedConnectorActions, pendingApprovals, dismissedApprovalIds]
  );
  const memoryState = useMemo<MemoryControlState>(
    () => ({
      disabled: memoryDisabled,
      records: managedMemoryRecords
    }),
    [managedMemoryRecords, memoryDisabled]
  );
  const shellState = useMemo<PersistedShellState>(
    () => ({
      activeItem,
      composerValue,
      voiceEnabled,
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
      permissionMode,
      permissionLabel,
      customApprovalSettings
    }),
    [
      activeItem,
      approvalAudit,
      approvalRules,
      agents,
      activeAgentId,
      composerValue,
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
      voiceEnabled
    ]
  );

  // Keep the latest persisted snapshot in a ref so the debounced persistence
  // effects below always write the most recent state. Composer typing flips
  // `composerValue` (a shellState dependency) on every keystroke; without
  // debouncing that triggered a synchronous localStorage write AND a Rust
  // snapshot save per key. Coalescing into a single trailing write keeps the
  // draft-restoration behavior identical while removing per-keystroke I/O from
  // the render path.
  const shellStateRef = useRef(shellState);
  shellStateRef.current = shellState;
  // Track whether a debounced localStorage write is still pending so an unmount
  // flush can guarantee the final state lands in storage (tests and real
  // teardowns rely on the draft being persisted). Rapid changes simply reset
  // the timer; only the trailing write fires.
  const persistTimerRef = useRef<number | null>(null);
  const snapshotTimerRef = useRef<number | null>(null);

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
    if (!runtimeSnapshotReady || !activeWorkspaceScope) {
      return;
    }

    // Debounced to coalesce rapid shellState changes (notably composer typing)
    // into a single trailing snapshot save through the Rust boundary, reading
    // the latest state from the ref so no keystroke's draft is lost.
    if (snapshotTimerRef.current !== null) {
      window.clearTimeout(snapshotTimerRef.current);
    }
    snapshotTimerRef.current = window.setTimeout(() => {
      snapshotTimerRef.current = null;
      void saveRuntimeSnapshot(shellStateToRuntimeSnapshot(shellStateRef.current)).catch((error) => {
        setLastAction(error instanceof Error ? error.message : "Fable could not save runtime snapshot.");
      });
    }, 300);
  }, [activeWorkspaceScope?.workspaceId, runtimeSnapshotReady, shellState]);

  // Flush any pending snapshot save on unmount so the final state is captured.
  useEffect(() => {
    return () => {
      if (snapshotTimerRef.current !== null) {
        window.clearTimeout(snapshotTimerRef.current);
        snapshotTimerRef.current = null;
        void saveRuntimeSnapshot(shellStateToRuntimeSnapshot(shellStateRef.current)).catch(() => undefined);
      }
    };
  }, [workspaceScopeGeneration]);

  useEffect(() => {
    let active = true;
    if (!activeWorkspaceScope) {
      setRuntimeSnapshotReady(false);
      return () => {
        active = false;
      };
    }

    // A switch is a hard tenant boundary. Drop everything that can have been
    // loaded for the prior scope before any new asynchronous hydration lands.
    // Preview is an intentional in-memory fixture, so retain its seeded data.
    if (hasTauriRuntime()) {
      setActiveItem(defaultShellState.activeItem);
      setComposerValue(defaultShellState.composerValue);
      setToolPickerOpen(false);
      setCommandOpen(false);
      setRuntimeSnapshotReady(false);
      setApprovalAudit([]);
      setActionHistory([]);
      setApprovalRules([]);
      setBackendToolApprovals([]);
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
      setComposerAttachments([]);
      setConnectorImportedSources([]);
      setConnectorManifests(connectors);
      setConnectorAccounts({});
      setConnectorStatus(null);
      setConnectorSearchResult(null);
      setPreparedConnectorActions([]);
      setKnowledgeCitations([]);
      setKnowledgeSearchMode("lexical-fallback");
      setManagedMemoryRecords([]);
      setMemoryDisabled(false);
      setEditingMemoryId(null);
      setMemoryExportText("");
      setKnowledgeExportText("");
    }

    void loadRuntimeSnapshot()
      .then((snapshot: RuntimeSnapshot | null) => {
        if (!active || !snapshot) {
          return;
        }

        const recovered = shellStateFromRuntimeSnapshot(snapshot, defaultShellState);
        setActiveItem(recovered.activeItem);
        setComposerValue(recovered.composerValue);
        setVoiceEnabled(recovered.voiceEnabled);
        setApprovalAudit(recovered.approvalAudit);
        setDismissedApprovalIds(recovered.dismissedApprovalIds);
        setApprovalRules(recovered.approvalRules);
        setAgents(recovered.agents?.length ? recovered.agents : defaultShellState.agents ?? []);
        setActiveAgentId(
          recovered.activeAgentId ?? recovered.agents?.[0]?.id ?? "chief-of-staff"
        );
        setPinnedSourceIds(recovered.pinnedSourceIds);
        setImportedKnowledgeSources(recovered.importedKnowledgeSources);
        setMemoryDisabled(recovered.memoryDisabled);
        setManagedMemoryRecords(recovered.memoryRecords.filter((record) => !record.forgottenAt));
        // A saved snapshot records the user's previous provider choice, not
        // proof that credentials are still valid. Native connected state is
        // restored only by the live provider probes above.
        if (!hasTauriRuntime()) {
          setConnectedBackendIds(
            recovered.connectedBackendIds.filter(isFableProviderEnabled)
          );
        }
        setOnboardingDismissed(recovered.onboardingComplete ?? false);
        setOnboardingVersion(recovered.onboardingVersion ?? 0);
        setSelectedModelId(recovered.selectedModelId);
        setPermissionMode(recovered.permissionMode);
        setPermissionLabel(
          isApprovalPresetLabel(recovered.permissionLabel)
            ? recovered.permissionLabel
            : permissionLabelFor(recovered.permissionMode)
        );
        setCustomApprovalSettings(
          normalizeCustomApprovalSettings(recovered.customApprovalSettings)
        );
        setLastAction("Recovered workspace from local runtime");
      })
      .finally(() => {
        if (active) {
          setRuntimeSnapshotReady(true);
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

  const applyAccountWorkspaceStatus = useCallback((status: AccountWorkspaceStatus) => {
    const canUseWorkspace =
      status.accountBound &&
      (status.state === "ready" || status.state === "offline") &&
      status.activeWorkspace.localWorkspaceId.length > 0;
    if (canUseWorkspace) {
      setActiveRuntimeDataScope(status.activeWorkspace.localWorkspaceId);
    } else {
      clearActiveRuntimeDataScope();
    }
    setAccountWorkspaceStatus(status);
    setWorkspaceScopeGeneration((current) => current + 1);
  }, []);

  const refreshAccountWorkspace = useCallback(async (reconcile = false) => {
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
      const message = error instanceof Error ? error.message : "Fable could not load account workspaces.";
      const failed: AccountWorkspaceStatus = {
        ...accountWorkspaceFallback,
        state: "error",
        accountBound: false,
        message
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
  }, [applyAccountWorkspaceStatus]);

  const refreshIdentityStatus = useCallback(async () => {
    const status = await loadRuntimeIdentityStatus();
    setIdentityStatus(status ?? (hasTauriRuntime() ? DEFAULT_IDENTITY_STATUS : PREVIEW_IDENTITY_STATUS));
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
      const next = status ?? (hasTauriRuntime() ? DEFAULT_IDENTITY_STATUS : PREVIEW_IDENTITY_STATUS);
      setIdentityStatus(next);
      if (next.state === "signed-in") {
        await refreshAccountWorkspace(true);
      }
      setLastAction(next.message);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Fable cloud sign-in is unavailable.";
      setIdentityStatus((current) => ({
        ...current,
        state: current.enabled ? "error" : "disabled",
        message
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
      const next = status ?? (hasTauriRuntime() ? DEFAULT_IDENTITY_STATUS : PREVIEW_IDENTITY_STATUS);
      setIdentityStatus(next);
      if (next.state === "signed-in") await refreshAccountWorkspace(true);
      setLastAction(next.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Fable account recovery is unavailable.";
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
        error instanceof Error ? error.message : "Fable cloud identity could not refresh.";
      setIdentityStatus((current) => ({
        ...current,
        state: current.enabled ? "error" : "disabled",
        message
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
      await clearRuntimeAccountWorkspaceSession();
      clearActiveRuntimeDataScope();
      applyAccountWorkspaceStatus({
        ...DEFAULT_ACCOUNT_WORKSPACE_STATUS,
        state: "signed-out",
        accountBound: false,
        message: "Signed out. Sign in to access Fable workspaces."
      });
      const next = status ?? (hasTauriRuntime() ? DEFAULT_IDENTITY_STATUS : PREVIEW_IDENTITY_STATUS);
      setIdentityStatus(next);
      setLastAction(next.message);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Fable cloud identity could not sign out.";
      setIdentityStatus((current) => ({
        ...current,
        state: current.enabled ? "error" : "disabled",
        message
      }));
      setLastAction(message);
    } finally {
      setIdentityPending(false);
    }
  }, [applyAccountWorkspaceStatus]);

  const reconcileAccountWorkspace = useCallback(async () => {
    const status = await refreshAccountWorkspace(identityStatus.state === "signed-in");
    setLastAction(status.message);
  }, [identityStatus.state, refreshAccountWorkspace]);

  const createAccountWorkspace = useCallback(async (name: string) => {
    const requestGeneration = ++accountRequestGenerationRef.current;
    setAccountWorkspacePending(true);
    try {
      const status = await createRuntimeAccountWorkspace(name);
      if (requestGeneration === accountRequestGenerationRef.current) {
        applyAccountWorkspaceStatus(status ?? accountWorkspaceFallback);
        setLastAction((status ?? accountWorkspaceFallback).message);
      }
    } finally {
      if (requestGeneration === accountRequestGenerationRef.current) setAccountWorkspacePending(false);
    }
  }, [applyAccountWorkspaceStatus]);

  const selectAccountWorkspace = useCallback(async (fableWorkspaceId: string) => {
    const requestGeneration = ++accountRequestGenerationRef.current;
    setAccountWorkspacePending(true);
    try {
      clearActiveRuntimeDataScope();
      setAccountWorkspaceStatus((current) => ({
        ...current,
        state: "bootstrapping",
        accountBound: false,
        message: "Switching workspace…"
      }));
      setWorkspaceScopeGeneration((current) => current + 1);
      const status = await selectRuntimeAccountWorkspace(fableWorkspaceId);
      if (requestGeneration === accountRequestGenerationRef.current) {
        applyAccountWorkspaceStatus(status ?? accountWorkspaceFallback);
        setLastAction((status ?? accountWorkspaceFallback).message);
      }
    } finally {
      if (requestGeneration === accountRequestGenerationRef.current) setAccountWorkspacePending(false);
    }
  }, [applyAccountWorkspaceStatus]);

  const revokeAccountDevice = useCallback(async (deviceId: string) => {
    const requestGeneration = ++accountRequestGenerationRef.current;
    setAccountWorkspacePending(true);
    try {
      const status = await revokeRuntimeAccountDevice(deviceId);
      if (requestGeneration === accountRequestGenerationRef.current) {
        applyAccountWorkspaceStatus(status ?? accountWorkspaceFallback);
        setLastAction((status ?? accountWorkspaceFallback).message);
      }
    } finally {
      if (requestGeneration === accountRequestGenerationRef.current) setAccountWorkspacePending(false);
    }
  }, [applyAccountWorkspaceStatus]);

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
      setPinnedSourceIds((current) => Array.from(new Set([...current, ...sources.map((source) => source.id)])));
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
              : "Fable could not load connector knowledge."
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
      if (!active || !state || (!state.disabled && state.records.length === 0)) {
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
      listRuntimeConnectorSyncStates()
    ]).then(async ([manifests, syncStates]) => {
      if (!active || !manifests) {
        return;
      }
      const connectionEntries = await Promise.all(
        manifests
          .filter((manifest) => manifest.status === "connected")
          .map(async (manifest) => [
            manifest.id,
            await listRuntimeConnectorAccounts(manifest.id) ?? []
          ] as const)
      );
      if (!active) return;
      const syncById = new Map(syncStates?.map((state) => [state.connectorId, state]) ?? []);
      const runtimeById = new Map(manifests.map((manifest) => [manifest.id, manifest]));
      setConnectorAccounts(Object.fromEntries(connectionEntries));
      setConnectorManifests((current) =>
        current.map((manifest) => {
          const runtime = runtimeById.get(manifest.id) ?? manifest;
          const sync = syncById.get(manifest.id);
          return sync ? { ...runtime, sync } : runtime;
        })
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

      // ACP providers (Cursor/Grok): the Rust list_backends path reports them
      // install-required by default. Probe each installed CLI's auth state
      // through the Rust boundary (detect_acp_cli — never reads a secret) and
      // merge the truthful auth state + capabilities so a signed-in CLI reaches
      // connected. Native + other backends keep their resolved state as-is.
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
        [providerId]: "loading"
      }));
      const result = await listRuntimeBackendModels(providerId);
      // null means preview/no desktop runtime. Mark this attempt unsupported so
      // the automatic discovery effect cannot spin idle -> loading -> idle.
      // A manual refresh can still call this entry point again.
      if (result === null) {
        setModelDiscoveryByProvider((current) => ({
          ...current,
          [providerId]: "unsupported"
        }));
        return;
      }
      setDiscoveredModels((current) => ({
        ...current,
        [providerId]: result
      }));
      // Map the runtime outcome onto the UI lifecycle. `empty`/`offline`/
      // `unsupported`/`failed` are kept distinct so failed/offline never
      // masquerade as an empty account.
      setModelDiscoveryByProvider((current) => ({
        ...current,
        [providerId]: result.outcome
      }));
      if (result.outcome === "failed") {
        setBackendStatus(result.message ?? "Model discovery failed; using the curated catalogue.");
      }
    },
    []
  );

  // Auto-run discovery for every connected native API provider. Provider-owned
  // runtimes expose their own fixed/default choices and are not sent through
  // the Rust HTTP model-list command.
  useEffect(() => {
    for (const provider of connectedAgentBackends) {
      if (
        provider.backendType === "native-api" &&
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
      const provider = backendProviders.find((entry) => entry.id === providerId);
      if (!provider || provider.authState !== "connected") {
        return;
      }
      await runModelDiscovery(providerId);
    },
    [backendProviders, runModelDiscovery]
  );

  const focusComposer = (value: string) => {
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(value.length, value.length);
    });
  };

  const toggleVoice = () => {
    setVoiceEnabled((enabled) => {
      setLastAction(enabled ? "Voice paused" : "Voice ready");
      return !enabled;
    });
  };

  const triggerAttach = () => {
    setImportStatus("Choose files or images to attach.");
    fileInputRef.current?.click();
  };

  const triggerFolderImport = () => {
    setImportStatus("Choose a folder containing supported knowledge files.");
    folderInputRef.current?.click();
  };

  const addImportedKnowledgeSource = (source: LocalFileImport) => {
    setImportedKnowledgeSources((current) =>
      [source, ...current.filter((existing) => existing.id !== source.id)].slice(
        0,
        MAX_IMPORTED_KNOWLEDGE_SOURCES
      )
    );
    setPinnedSourceIds((current) => (current.includes(source.id) ? current : [...current, source.id]));
  };

  const importLocalKnowledgeFile = async (file: File, sourceName = file.name) => {
    setImportStatus(`Reading ${sourceName}...`);

    try {
      const content = await readFileAsText(file);
      const candidate: LocalTextFileCandidate = {
        name: sourceName,
        content,
        sizeBytes: file.size,
        importedAt: new Date().toISOString()
      };
      // Surface the indexing state before the (async) native import resolves so
      // the user sees the source move reading -> indexing -> indexed.
      setImportStatus(`Indexing ${sourceName}...`);
      const nativeImported = await importRuntimeLocalKnowledgeSource(candidate);
      const imported = nativeImported ?? importLocalTextFile(candidate);
      // The imported source is indexed and healthy. Unchanged re-imports (same
      // content fingerprint) replace the existing row in place via
      // addImportedKnowledgeSource's dedupe-by-id, so no phantom duplicate rows
      // appear for unchanged imports.
      const indexed: LocalFileImport = {
        ...imported,
        status: "ok",
        statusMessage: undefined
      };

      if (importedKnowledgeSources.some((source) => source.id === imported.id && source.deletedAt)) {
        throw new Error("Deleted knowledge cannot be restored by a backup import.");
      }

      addImportedKnowledgeSource(indexed);
      setImportStatus(`Imported ${indexed.title}. It is pinned as untrusted knowledge.`);
      setLastAction(`Imported source: ${indexed.title}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Fable could not import that file.";
      // Import failure must not leave a phantom source or stale optimistic
      // state: nothing was added, so we surface the failure and clear indexing.
      setImportStatus(message);
      setLastAction(message);
      return false;
    }
  };

  const saveTextToKnowledge = (title: string, content: string) => {
    const sourceName = `${toSlug(title).slice(0, 72)}.md`;
    return importLocalKnowledgeFile(
      new File([content], sourceName, { type: "text/markdown" }),
      sourceName
    );
  };

  const supportedKnowledgeExtensions = useMemo(
    () => new Set(SUPPORTED_LOCAL_FILE_EXTENSIONS.map((extension) => extension.toLowerCase())),
    []
  );

  const attachmentIdFor = (file: File) =>
    `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${toSlug(file.name)}`;

  const isKnowledgeAttachment = (file: File) => {
    const extension = file.name.split(".").pop()?.toLowerCase();
    return Boolean(extension && supportedKnowledgeExtensions.has(extension));
  };

  const updateComposerAttachment = (id: string, patch: Partial<ComposerAttachment>) => {
    setComposerAttachments((current) =>
      current.map((attachment) =>
        attachment.id === id ? { ...attachment, ...patch } : attachment
      )
    );
  };

  const addComposerAttachment = async (file: File) => {
    const id = attachmentIdFor(file);
    const attachment: ComposerAttachment = {
      id,
      name: file.name,
      type: file.type,
      sizeBytes: file.size,
      status: file.type.startsWith("image/") ? "Previewing" : "Attached"
    };
    setComposerAttachments((current) => [attachment, ...current].slice(0, 12));

    if (file.type.startsWith("image/")) {
      try {
        const previewUrl = await readFileAsDataUrl(file);
        updateComposerAttachment(id, { previewUrl, status: "Attached" });
      } catch (error) {
        updateComposerAttachment(id, {
          status: error instanceof Error ? error.message : "Preview unavailable"
        });
      }
      setImportStatus(`${file.name} attached.`);
      return;
    }

    if (isKnowledgeAttachment(file)) {
      updateComposerAttachment(id, { status: "Indexing" });
      const imported = await importLocalKnowledgeFile(file);
      updateComposerAttachment(id, {
        status: imported ? "Imported as knowledge" : "Attached"
      });
      return;
    }

    setImportStatus(`${file.name} attached.`);
  };

  const handleComposerAttachmentChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length === 0) return;
    void Promise.all(files.map((file) => addComposerAttachment(file)));
  };

  const removeComposerAttachment = (attachmentId: string) => {
    setComposerAttachments((current) =>
      current.filter((attachment) => attachment.id !== attachmentId)
    );
  };

  const handleLocalKnowledgeFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (!file) {
      return;
    }

    void importLocalKnowledgeFile(file);
  };

  const handleLocalKnowledgeFolderChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []).slice(
      0,
      MAX_IMPORTED_KNOWLEDGE_SOURCES
    );
    event.currentTarget.value = "";

    if (files.length === 0) {
      return;
    }

    void (async () => {
      let importedCount = 0;
      for (const file of files) {
        if (await importLocalKnowledgeFile(file, file.webkitRelativePath || file.name)) {
          importedCount += 1;
        }
      }
      setImportStatus(
        importedCount === files.length
          ? `Imported ${importedCount} files from the selected folder.`
          : `Imported ${importedCount} of ${files.length} files. Unsupported or invalid files were skipped.`
      );
    })();
  };

  const runKnowledgeSearch = async (query: string) => {
    const result = await retrieve(knowledgeRetrievalSources(), {
      query,
      scope: knowledgeScopeForRun(activeThread?.id),
      limit: 8,
      budgetChars: 6_000
    });

    setKnowledgeCitations(result.citations);
    setKnowledgeSearchMode(result.mode);
    setLastAction(
      result.citations.length > 0
        ? `Found ${result.citations.length} cited workspace sources`
        : "No matching workspace sources found"
    );
  };

  const connectionIsAuthorized = (
    connectorId: string,
    _account?: string,
    connectionId?: string
  ) => {
    if (connectorId === "local-files") return true;
    if (!connectionId) return false;
    if (!hasTauriRuntime()) {
      return ALLOW_PREVIEW_FALLBACKS
        && connectionId === `fixture-preview:${connectorId}`;
    }
    const connection = connectorAccounts[connectorId]?.find(
      (candidate) => candidate.connectionId === connectionId
    );
    return Boolean(
      connection
      && connection.lifecycle === "authorized"
      && connection.authorizationState === "authorized"
      && connection.credentialState === "available"
      && connection.healthState !== "unhealthy"
      && connection.healthState !== "offline"
    );
  };

  const sourceIsAuthorized = (source: KnowledgeSource) => {
    if (source.disabled || source.deletedAt || source.status === "stale" || source.status === "error") return false;
    return connectionIsAuthorized(source.connectorId, source.account, source.connectionId);
  };

  const knowledgeRetrievalSources = (
    sources: readonly KnowledgeSource[] = workspaceKnowledgeSources,
    context?: KnowledgeRunContext
  ) =>
    sources
      // Only live (non-disabled), authorized, connected-connector sources can
      // enter retrieval. Stale/error statuses are additionally excluded by the
      // retrieval filter; we re-check live here so a
      // disabled source is never even chunked.
      .filter((source) =>
        isLiveSource(source)
        && sourceIsAuthorized(source)
        && sourceAllowedByConnections(source, context)
        && (!context?.allowedConnectorIds || source.connectorId === "local-files" || context.allowedConnectorIds.includes(source.connectorId))
        && (!context?.allowedKnowledgeSourceIds || context.allowedKnowledgeSourceIds.includes(source.id))
      )
      .map((source) => ({
        source,
        chunks: chunkSourceText(source.contentPreview ?? "", {
          sourceId: source.id,
          mimeType: source.providerMetadata?.mimeType
        })
      }))
      .filter((record) => record.chunks.length > 0);

  const assembleKnowledgeContext = async (
    query: string,
    context?: KnowledgeRunContext
  ): Promise<PreparedExecutionContext> => {
    const attemptId = createExecutionAttemptId();
    const assembledAt = new Date().toISOString();
    const scope = knowledgeScopeForRun(activeThread?.id);
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
    const visibleSources = recordsVisibleToRunAudience(governedSources, audience);
    const visibleMemory = recordsVisibleToRunAudience(governedMemory, audience);
    const result = await retrieve(knowledgeRetrievalSources(visibleSources, context), {
      query,
      scope,
      audience,
      limit: 8,
      budgetChars: 6_000
    });
    setKnowledgeCitations(result.citations);
    setKnowledgeSearchMode(result.mode);
    const assembled = assembleContext({
      attemptId,
      assembledAt,
      scope,
      audience,
      // Only live memories enter context: forgotten/disabled records are
      // excluded by isLiveMemory. Memory-disabled (the workspace-level kill
      // switch) excludes everything.
      memory: memoryDisabled ? [] : visibleMemory,
      citations: result.citations,
      authorization: {
        isSourceAuthorized: connectionIsAuthorized
      }
    });
    return Object.freeze({
      systemPrefix: assembled.systemPrefix,
      receipt: assembled.receipt
    });
  };

  /**
   * Persist local knowledge sources optimistically, rolling back to the prior
   * authoritative state if the native save fails so the UI never shows a source
   * change (delete/disable/refresh) that was never persisted. Connector-imported
   * sources are mirrored in parallel since they share the same workspace view.
   */
  const persistLocalKnowledgeSources = (sources: LocalFileImport[]) => {
    const previous = importedKnowledgeSources;
    setImportedKnowledgeSources(sources);
    void saveRuntimeImportedKnowledgeSources(sources).catch((error) => {
      setImportedKnowledgeSources(previous);
      setImportStatus(
        error instanceof Error ? error.message : "Fable could not save source changes."
      );
    });
  };

  const refreshKnowledgeSource = async (sourceId: string, file?: File) => {
    const localTarget = importedKnowledgeSources.find((source) => source.id === sourceId);
    if (localTarget) {
      if (!file) throw new Error(`Choose the current version of ${localTarget.title}.`);
      try {
        const request = await buildLocalKnowledgeRefreshRequest(localTarget, file);
        const response = await refreshRuntimeLocalKnowledgeSource(request);
        if (!response) throw new Error("Fable could not update that file.");
        if (response.outcome === "updated") {
          setImportedKnowledgeSources((current) => current.map((source) => source.id === sourceId
            ? {
                ...response.source,
                pinned: source.pinned,
                disabled: source.disabled,
                ...(source.deletedAt ? { deletedAt: source.deletedAt } : {})
              }
            : source));
          setImportStatus(`Updated from ${file.name}.`);
        } else {
          setImportStatus("This source is already up to date.");
        }
        setLastAction(response.outcome === "updated" ? `Updated from ${file.name}.` : "This source is already up to date.");
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Fable could not update that file.";
        setImportStatus(message);
        setLastAction(message);
        throw error;
      }
    }

    const connectorTarget = connectorImportedSources.find((source) => source.id === sourceId);
    if (connectorTarget) {
      const message = `Open Connections and import ${connectorTarget.title} again to refresh it.`;
      setImportStatus(message);
      setLastAction(message);
      return;
    }
    throw new Error("That knowledge source is no longer available.");
  };

  const toggleKnowledgeSourceDisabled = (sourceId: string) => {
    const target = workspaceKnowledgeSources.find((source) => source.id === sourceId);
    const becomingDisabled = target ? !target.disabled : true;
    const toggle = <T extends KnowledgeSource>(sources: T[]) =>
      sources.map((source) =>
        source.id === sourceId ? { ...source, disabled: !source.disabled } : source
      );
    if (importedKnowledgeSources.some((source) => source.id === sourceId)) {
      persistLocalKnowledgeSources(toggle(importedKnowledgeSources));
    } else if (connectorImportedSources.some((source) => source.id === sourceId)) {
      const previous = connectorImportedSources;
      setConnectorImportedSources(toggle(previous));
      void setRuntimeConnectorKnowledgeSourceDisabled(sourceId, becomingDisabled)
        .then((saved) => {
          if (saved) {
            setConnectorImportedSources((current) =>
              current.map((source) => source.id === sourceId ? saved : source)
            );
          }
        })
        .catch((error) => {
          setConnectorImportedSources(previous);
          setImportStatus(
            error instanceof Error ? error.message : "Fable could not save that source change."
          );
        });
    }
    // A disabled source cannot remain pinned: drop the pin so disabled material
    // can never enter a run via the pinned-context path.
    if (becomingDisabled) {
      setPinnedSourceIds((current) => current.filter((id) => id !== sourceId));
    }
    setLastAction(becomingDisabled ? "Knowledge source disabled" : "Knowledge source re-enabled");
  };

  const deleteKnowledgeSource = (sourceId: string) => {
    const deletedAt = new Date().toISOString();
    // Permanently remove the source from search, citations, pins, and context.
    // Pins for the deleted source are cleared so they cannot resolve to a
    // missing source or bypass the removal via pinned context.
    if (importedKnowledgeSources.some((source) => source.id === sourceId)) {
      persistLocalKnowledgeSources(
        importedKnowledgeSources.map((source) =>
          source.id === sourceId
            ? { ...source, pinned: false, disabled: true, deletedAt }
            : source
        )
      );
    } else if (connectorImportedSources.some((source) => source.id === sourceId)) {
      const previous = connectorImportedSources;
      setConnectorImportedSources((current) =>
        current.filter((source) => source.id !== sourceId)
      );
      void deleteRuntimeConnectorKnowledgeSource(sourceId).catch((error) => {
        setConnectorImportedSources(previous);
        setImportStatus(
          error instanceof Error ? error.message : "Fable could not delete that source."
        );
      });
    }
    setPinnedSourceIds((current) => current.filter((id) => id !== sourceId));
    setLastAction("Knowledge source deleted");
  };

  const commitMemoryState = (state: MemoryControlState, status: string) => {
    // Capture the pre-change state so a native save failure rolls back the
    // optimistic update instead of leaving a phantom record in the UI.
    const previousDisabled = memoryDisabled;
    const previousRecords = managedMemoryRecords;
    setMemoryDisabled(state.disabled);
    setManagedMemoryRecords(state.records.filter((record) => !record.forgottenAt));
    setMemoryStatus(status);

    void saveRuntimeMemoryState(state)
      .then((runtimeState) => {
        if (!runtimeState) {
          return;
        }

        setMemoryDisabled(runtimeState.disabled);
        setManagedMemoryRecords(runtimeState.records);
      })
      .catch((error) => {
        // The native save failed: roll back to the prior authoritative state so
        // the UI does not falsely show a change that was never persisted.
        setMemoryDisabled(previousDisabled);
        setManagedMemoryRecords(previousRecords);
        setMemoryStatus(
          error instanceof Error ? error.message : "Fable could not save memory state."
        );
      });
  };

  const startMemoryEdit = (record: MemoryRecord) => {
    setEditingMemoryId(record.id);
    setEditingMemoryDraft({
      title: record.title,
      value: record.value
    });
    setMemoryStatus(`Editing memory: ${record.title}`);
  };

  const saveMemoryEdit = (recordId: string) => {
    const title = editingMemoryDraft.title.trim();
    const value = editingMemoryDraft.value.trim();

    if (!title || !value) {
      setMemoryStatus("Memory title and value are required.");
      return;
    }

    const now = new Date().toISOString();
    const nextRecords = managedMemoryRecords.map((record) =>
      record.id === recordId
        ? { ...editMemory(record, { title, value }, now), freshness: "Updated now" }
        : record
    );

    setEditingMemoryId(null);
    setEditingMemoryDraft({ title: "", value: "" });
    commitMemoryState({ disabled: memoryDisabled, records: nextRecords }, "Memory updated.");
  };

  const cancelMemoryEdit = () => {
    setEditingMemoryId(null);
    setEditingMemoryDraft({ title: "", value: "" });
    setMemoryStatus("Memory edit cancelled.");
  };

  const forgetMemory = (recordId: string) => {
    const now = new Date().toISOString();
    const target = managedMemoryRecords.find((record) => record.id === recordId);
    // Forget is the durable exclusion signal: the record is tombstoned with
    // `forgottenAt` so it disappears from every retrieval / context / export /
    // management read path while remaining auditable. Distinct from a temporary
    // disable (which keeps the record visible in management views).
    const nextRecords = managedMemoryRecords.map((record) =>
      record.id === recordId ? forgetMemoryRecord(record, now) : record
    );
    setEditingMemoryId((current) => (current === recordId ? null : current));
    // A forgotten memory can no longer be pinned; drop the pin so it cannot
    // bypass exclusion via the pinned-context path.
    setManagedMemoryRecords(nextRecords);
    setMemoryDisabled(memoryDisabled);
    setMemoryStatus(target ? `Forgot memory: ${target.title}` : "Memory forgotten.");
    void saveRuntimeMemoryState({ disabled: memoryDisabled, records: nextRecords })
      .then((runtimeState) => {
        if (runtimeState) {
          setMemoryDisabled(runtimeState.disabled);
          setManagedMemoryRecords(runtimeState.records);
        }
      })
      .catch((error) => {
        setMemoryStatus(
          error instanceof Error ? error.message : "Fable could not forget that memory."
        );
      });
    setLastAction(target ? `Forgot memory: ${target.title}` : "Memory forgotten.");
  };

  /**
   * Toggle a single memory's disabled state. A disabled memory is excluded from
   * retrieval, context, and export (like a forgotten one) but stays visible in
   * the management view and can be re-enabled — no record duplication. Pinning
   * is dropped while disabled so it cannot bypass the exclusion via pinned
   * context.
   */
  const toggleMemoryRecordDisabled = (recordId: string) => {
    const now = new Date().toISOString();
    const target = managedMemoryRecords.find((record) => record.id === recordId);
    if (!target) return;
    const becomingDisabled = !target.disabled;
    const nextRecords = managedMemoryRecords.map((record) =>
      record.id === recordId
        ? becomingDisabled
          ? disableMemoryRecord(record, now)
          : { ...record, disabled: false, updatedAt: now }
        : record
    );
    commitMemoryState(
      { disabled: memoryDisabled, records: nextRecords },
      becomingDisabled ? `Disabled memory: ${target.title}` : `Re-enabled memory: ${target.title}`
    );
  };

  const toggleMemoryPin = (recordId: string) => {
    const target = managedMemoryRecords.find((record) => record.id === recordId);
    if (!target) return;
    // Pinning must not bypass exclusion: a disabled or forgotten memory cannot
    // be pinned. Unpinning a currently-pinned record is always allowed so a
    // stale pin can be cleared.
    if (!target.pinned && !isLiveMemory(target)) {
      setMemoryStatus("Disabled or forgotten memories cannot be pinned.");
      return;
    }
    const nextRecords = managedMemoryRecords.map((record) =>
      record.id === recordId ? { ...record, pinned: !record.pinned } : record
    );
    const changed = nextRecords.find((record) => record.id === recordId);
    commitMemoryState(
      { disabled: memoryDisabled, records: nextRecords },
      changed?.pinned ? "Memory pinned." : "Memory unpinned."
    );
  };

  const toggleMemoryDisabled = () => {
    commitMemoryState(
      { disabled: !memoryDisabled, records: managedMemoryRecords },
      memoryDisabled ? "Memory enabled." : "Memory disabled."
    );
  };

  const exportMemory = async () => {
    try {
      // Live memories only: forgotten/disabled records are excluded by
      // `exportMemories`. The native export is authoritative when present; the
      // fallback re-applies the same live-only filter so secrets never ride
      // along on a forgotten record's payload and disabled records never leak.
      const liveFallback = exportMemories(memoryState.records);
      const exported = (await exportRuntimeMemoryState(memoryState)) ?? liveFallback;
      setMemoryExportText(exported);
      setMemoryStatus("Memory export ready.");
    } catch (error) {
      setMemoryStatus(error instanceof Error ? error.message : "Fable could not export memory.");
    }
  };

  /**
   * Export the current workspace's knowledge (live sources + live memories) as
   * plain text. Disabled sources and forgotten/disabled memories are excluded;
   * secrets, connector tokens, and raw audit payloads are never part of a
   * source or memory record, so they cannot appear. Source content is capped to
   * a readable preview to avoid dumping full provider cache payloads.
   */
  const exportKnowledge = async () => {
    try {
      const liveSources = workspaceKnowledgeSources.filter(isLiveSource);
      const liveMemories = managedMemoryRecords.filter(isLiveMemory);
      const lines: string[] = ["# Knowledge export", ""];

      lines.push("## Sources", "");
      if (liveSources.length === 0) {
        lines.push("(no live sources)");
      } else {
        for (const source of liveSources) {
          lines.push(`- ${source.title}`);
          const meta = [
            `provenance: ${source.provenance}`,
            `freshness: ${source.freshness}`,
            `connector: ${source.connectorId}`,
            source.account ? `account: ${source.account}` : "",
            source.trust ? `trust: ${source.trust}` : ""
          ].filter(Boolean);
          lines.push(`  _(${meta.join(" | ")})_`);
        }
      }
      lines.push("");
      lines.push(exportMemories(liveMemories));

      setKnowledgeExportText(lines.join("\n").trimEnd());
      setLastAction("Knowledge export ready.");
    } catch (error) {
      setKnowledgeExportText("");
      setLastAction(
        error instanceof Error ? error.message : "Fable could not export knowledge."
      );
    }
  };

  const promoteSourceToMemory = async (source: KnowledgeSource) => {
    // Promotion must respect the same exclusion rules as retrieval: a disabled
    // source, or one from a disconnected/unauthorized connector, cannot be
    // promoted into memory (it would bypass the disable/authorization gate).
    if (!isLiveSource(source)) {
      setMemoryStatus("Disabled sources cannot be promoted to memory.");
      return;
    }
    if (!sourceIsAuthorized(source)) {
      setMemoryStatus("Connect the source's service before promoting it to memory.");
      return;
    }
    const request: MemoryPromotionRequest = {
      source,
      decision: "once",
      decidedAt: new Date().toISOString(),
      state: memoryState
    };

    try {
      const response = runtimeOrPreview(
        await promoteRuntimeKnowledgeSourceToMemory(request),
        () => promoteKnowledgeSourceFallback(request),
        "Memory changes require the desktop runtime."
      );
      setApprovalAudit((current) => prependAuditEntry(current, response.auditEntry));
      commitMemoryState(response.state, `Approved memory: ${response.record.title}`);
      setPinnedSourceIds((current) => (current.includes(source.id) ? current : [...current, source.id]));
      setLastAction(`Approved ${source.title} into memory`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Fable could not approve that source into memory.";
      setMemoryStatus(message);
      setLastAction(message);
    }
  };

  const useDirective = (directive: WorkspaceDirective) => {
    setComposerValue(directive.prompt);
    setLastAction(`Loaded directive: ${directive.label}`);
    focusComposer(directive.prompt);
  };

  const openThread = (thread: ThreadSummary, label: string) => {
    setActiveItem(thread.id);
    setMobileNavOpen(false);
    setLastAction(`Opened ${label}: ${thread.title}`);
  };

  const startNewChat = () => {
    setActiveItem("new-chat");
    setComposerValue("");
    setMobileNavOpen(false);
    setLastAction("New chat ready");
    focusComposer("");
  };

  const submitPrompt = (prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed) {
      setKnowledgeCitations([]);
      setLastAction("Choose a directive or write a prompt.");
      return;
    }

    setComposerValue(trimmed);
    void runKnowledgeSearch(trimmed);
  };

  const submitComposer = (event: FormEvent) => {
    event.preventDefault();
    submitPrompt(composerValue);
  };

  const useConnector = (connector: ConnectorManifest) => {
    const prompt = `Use @${connector.id} with the current workspace context.`;
    setComposerValue(prompt);
    setLastAction(`${connector.name} is ready in the composer`);
    focusComposer(prompt);
  };

  const replaceConnectorManifest = (manifest: ConnectorManifest) => {
    setConnectorManifests((current) =>
      current.map((connector) => (connector.id === manifest.id ? manifest : connector))
    );
  };

  const connectConnector = async (connector: ConnectorManifest) => {
    if (!isFirstWaveConnectorId(connector.id)) {
      setConnectorStatus(
        connector.id === "local-files"
          ? "Local Files is already available."
          : connector.setupMessage ?? `${connector.name} is not in the first connector wave.`
      );
      return;
    }

    setConnectorStatus(`Preparing ${connector.name} authorization...`);
    try {
      // Every OAuth connector runs the full loopback flow end-to-end. Public
      // Google clients call Google directly; confidential connectors route
      // exchange through the configured broker and fail closed if it is absent.
      const result = await beginRuntimeConnectorOAuth({ connectorId: connector.id });
      if (!result) {
        // Preview mode (no Tauri runtime): no live OAuth is available. Surface
        // the configured-auth-required state honestly — never claim a fixture
        // connection as live.
        const message =
          connector.status === "fixture"
            ? `${connector.name} is using explicit preview data. ${connector.setupMessage ?? "Live provider setup is required."}`
            : connector.setupMessage ?? `${connector.name} provider setup is required.`;
        setConnectorStatus(message);
        setLastAction(message);
        return;
      }
      // On a real connection, re-read the boundary so the manifest reflects the
      // live account, granted scopes, and (after refresh) provider health.
      if (result.status === "connected") {
        const refreshed = await refreshRuntimeConnectorHealth(connector.id);
        if (refreshed) {
          replaceConnectorManifest(refreshed);
        }
        await loadConnectorAccounts(connector.id);
      }
      setConnectorStatus(result.message);
      setLastAction(result.message);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `${connector.name} authorization is unavailable.`;
      setConnectorStatus(message);
      setLastAction(message);
    }
  };

  const disconnectConnector = async (connectorId: string) => {
    const connector = connectorManifests.find((manifest) => manifest.id === connectorId);
    if (!connector || !isFirstWaveConnectorId(connectorId)) {
      return;
    }

    try {
      const manifest = await clearRuntimeConnectorAuth(connectorId);
      if (manifest) {
        replaceConnectorManifest(manifest);
        setConnectorStatus(`${connector.name} disconnected.`);
      } else {
        setConnectorStatus(`${connector.name} fixture has no live credentials to clear.`);
      }
    } catch (error) {
      setConnectorStatus(
        error instanceof Error ? error.message : `${connector.name} could not be disconnected.`
      );
    }
  };

  const loadConnectorAccounts = async (connectorId: string) => {
    if (!isFirstWaveConnectorId(connectorId)) return;
    try {
      const accounts = await listRuntimeConnectorAccounts(connectorId);
      if (accounts) {
        setConnectorAccounts((current) => ({ ...current, [connectorId]: accounts }));
      }
    } catch (error) {
      setConnectorStatus(error instanceof Error ? error.message : "Connected accounts are unavailable.");
    }
  };

  const switchConnectorAccount = async (connectorId: string, connectionId: string) => {
    if (!isFirstWaveConnectorId(connectorId)) return;
    try {
      const manifest = await switchRuntimeConnectorAccount(connectorId, connectionId);
      if (manifest) {
        replaceConnectorManifest(manifest);
        await loadConnectorAccounts(connectorId);
        setConnectorStatus(`Using ${manifest.account?.email ?? manifest.account?.displayName ?? "selected account"}.`);
      }
    } catch (error) {
      setConnectorStatus(error instanceof Error ? error.message : "The account could not be selected.");
    }
  };

  const refreshConnector = async (connectorId: string) => {
    const connector = connectorManifests.find((manifest) => manifest.id === connectorId);
    if (!connector || !isFirstWaveConnectorId(connectorId)) {
      return;
    }

    try {
      const sync = await syncRuntimeConnector({
        connectorId,
        workspaceId: activeWorkspaceScope?.workspaceId ?? "",
        trigger: "manual"
      });
      if (sync) {
        replaceConnectorManifest({ ...connector, sync });
        const outcome =
          sync.phase === "succeeded"
            ? "sync complete"
            : sync.failure?.message ?? `sync ${sync.phase}`;
        setConnectorStatus(`${connector.name} ${outcome}.`);
      } else {
        setConnectorStatus(`${connector.name} sync is unavailable in preview mode.`);
      }
    } catch (error) {
      setConnectorStatus(
        error instanceof Error ? error.message : `${connector.name} health is unavailable.`
      );
    }
  };

  const searchConnector = async (request: ConnectorSearchRequest) => {
    const connector = connectorManifests.find(
      (manifest) => manifest.id === request.connectorId
    );
    setConnectorStatus(`Searching ${connector?.name ?? request.connectorId}...`);
    try {
      const runtimeResult = await searchRuntimeConnector(request);
      const result = runtimeResult ?? (() => {
        const sessionGate = canUseBrowserSession(browserSession, request.connectorId, {
          allowFixturePreview: ALLOW_PREVIEW_FALLBACKS
        });
        if (!sessionGate.ok) {
          throw new Error(sessionGate.result.message);
        }
        const result = labelFixtureSearchResult(searchFixtureConnector(request));
        return {
          ...result,
          items: result.items.map((item) => ({
            ...item,
            connectionId: `fixture-preview:${item.connectorId}`
          }))
        };
      })();
      setConnectorSearchResult(result);
      setConnectorStatus(
        result.items.length > 0
          ? `Found ${result.items.length} ${result.source} result${result.items.length === 1 ? "" : "s"}.`
          : `No ${result.source} results matched.`
      );
    } catch (error) {
      setConnectorSearchResult({
        connectorId: request.connectorId,
        query: request.query,
        items: [],
        source: "live",
        searchedAt: new Date().toISOString()
      });
      setConnectorStatus(
        error instanceof Error ? error.message : "Connector search is unavailable."
      );
    }
  };

  const importConnectorItem = async (item: ConnectorSearchItem) => {
    const request = {
      connectorId: item.connectorId,
      item,
      importedAt: new Date().toISOString()
    };

    try {
      const runtimeImport = await importRuntimeConnectorItem(request);
      const imported = runtimeImport ?? (() => {
        const sessionGate = canUseBrowserSession(browserSession, request.connectorId, {
          allowFixturePreview: ALLOW_PREVIEW_FALLBACKS
        });
        if (!sessionGate.ok) {
          throw new Error(sessionGate.result.message);
        }
        return importFixtureConnectorItem(request);
      })();
      setConnectorImportedSources((current) => [
        imported.source,
        ...current.filter((source) => source.id !== imported.source.id)
      ]);
      setConnectorStatus(
        `Imported ${imported.source.title} as untrusted connector knowledge.`
      );
      setLastAction(`Imported connector source: ${imported.source.title}`);
    } catch (error) {
      setConnectorStatus(
        error instanceof Error ? error.message : "Connector import is unavailable."
      );
    }
  };

  const prepareConnectorAction = async (
    action: ConnectorActionKind,
    payload: Record<string, string>
  ) => {
    try {
      const fixtureRequest = {
        ...prepareFixtureConnectorAction(action, payload),
        permissionMode
      };
      const prepared = await prepareRuntimeConnectorAction(fixtureRequest) ?? (() => {
        const sessionGate = canUseBrowserSession(browserSession, fixtureRequest.connectorId, {
          allowFixturePreview: ALLOW_PREVIEW_FALLBACKS
        });
        if (!sessionGate.ok) {
          throw new Error(sessionGate.result.message);
        }
        return fixtureRequest;
      })();
      setPreparedConnectorActions((current) => [
        prepared,
        ...current.filter((request) => request.id !== prepared.id)
      ]);
      setConnectorStatus(
        `${prepared.approval.service} action prepared. Review it in Memory and approvals.`
      );
      setLastAction(`${prepared.approval.service} action needs approval`);
    } catch (error) {
      setConnectorStatus(
        error instanceof Error ? error.message : "Connector action could not be prepared."
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
          .map((provider) => provider.id)
      );
      return resolved;
    }
    return null;
  };

  const markProviderState = (providerId: string, authState: BackendProvider["authState"]) => {
    setBackendProviders((current) =>
      current.map((provider) =>
        provider.id === providerId
          ? {
              ...provider,
              authState,
              // Transient/non-connected states declare no capabilities.
              capabilities: authState === "connected" ? provider.capabilities : []
            }
          : provider
      )
    );
  };

  const connectBackendWithVerify = async (
    providerId: string,
    secret: string
  ): Promise<BackendVerifyResult> => {
    if (!isFableProviderEnabled(providerId)) {
      const message = "This provider is not available in the current Fable release.";
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
          current.includes(providerId) ? current : [...current, providerId]
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
        const message = "Fable could not verify this provider in the desktop runtime. Update Fable and try again.";
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
        const status = message ?? `${providerId} rejected this key. Check the key and try again.`;
        setBackendStatus(status);
        setLastAction(status);
        return { providerId, outcome, message: status };
      }

      if (outcome === "ready") {
        await refreshBackendProviders();
        setBackendStatus(`${providerId} connected.`);
        setLastAction(`${providerId} connected`);
        return { providerId, outcome };
      }

      // offline / unsupported / failed: retain the key so the user can retry,
      // but do not let key presence clear onboarding or claim readiness.
      await refreshBackendProviders();
      setConnectedBackendIds((current) => current.filter((id) => id !== providerId));
      markProviderState(providerId, "unavailable");
      const status = message ?? `${providerId} could not be verified. Retry before entering Fable.`;
      setBackendStatus(status);
      setLastAction(status);
      return { providerId, outcome, message };
    } catch (error) {
      // Storage itself failed. Fail closed: do not report a connection.
      markProviderState(providerId, "needs-auth");
      const message = error instanceof Error ? error.message : `Could not connect ${providerId}.`;
      setBackendStatus(message);
      setLastAction(message);
      return { providerId, outcome: "failed", message };
    }
  };

  const connectBackend = async (providerId: string, secret = "preview-connection") => {
    await connectBackendWithVerify(providerId, secret);
  };

  const checkBackendConnection = async (providerId: string): Promise<BackendVerifyResult> => {
    const provider = backendProviders.find((entry) => entry.id === providerId);
    if (!provider) {
      return { providerId, outcome: "failed", message: "This provider is not in Fable's runtime catalogue." };
    }

    if (provider.backendType !== "native-api") {
      const refreshed = await refreshBackendProviders();
      const current = refreshed?.find((entry) => entry.id === providerId) ?? provider;
      const ready = current.authState === "connected" || current.authState === "ready";
      const result: BackendVerifyResult = ready
        ? { providerId, outcome: "ready" }
        : {
            providerId,
            outcome: "failed",
            message: current.installHint ?? "The provider runtime is not connected yet."
          };
      setBackendStatus(result.message ?? `${providerId} connection checked.`);
      return result;
    }

    const result = await verifyRuntimeBackend(providerId);
    if (result === null) {
      const previewResult: BackendVerifyResult = {
        providerId,
        outcome: "unsupported",
        message: "Browser preview uses a synthetic provider connection; live health checks run in the desktop app."
      };
      setBackendStatus(previewResult.message ?? null);
      return previewResult;
    }

    if (result.outcome === "auth-failed") {
      await clearRuntimeBackend(providerId);
      await refreshBackendProviders();
      markProviderState(providerId, "needs-auth");
      setBackendStatus(result.message ?? `${providerId} rejected or revoked this key.`);
      return result;
    }

    await refreshBackendProviders();
    setBackendStatus(
      result.message ??
        (result.outcome === "ready"
          ? `${providerId} is healthy.`
          : `${providerId} could not be checked right now.`)
    );
    return result;
  };

  const startBackendBrowserLogin = async (providerId: string): Promise<BackendVerifyResult> => {
    if (providerId !== "codex") {
      return {
        providerId,
        outcome: "unsupported",
        message: "This provider does not expose a supported browser sign-in through Fable."
      };
    }
    markProviderState(providerId, "connecting");
    setBackendStatus("Opening the official ChatGPT sign-in…");
    try {
      const started = await startRuntimeCodexBrowserLogin();
      if (!started) {
        markProviderState(providerId, "needs-auth");
        return {
          providerId,
          outcome: "unsupported",
          message: "ChatGPT browser sign-in is available in the Fable desktop app."
        };
      }
      const verified = await checkBackendConnection(providerId);
      const result = verified.outcome === "ready"
        ? { providerId, outcome: "ready" as const, message: started.message }
        : verified;
      setBackendStatus(result.message ?? "ChatGPT connected.");
      setLastAction(result.message ?? "ChatGPT connected");
      return result;
    } catch (error) {
      markProviderState(providerId, "needs-auth");
      const message = error instanceof Error ? error.message : "ChatGPT sign-in could not be completed.";
      setBackendStatus(message);
      setLastAction(message);
      return { providerId, outcome: "failed", message };
    }
  };

  const disconnectBackend = async (providerId: string) => {
    setBackendStatus(`Disconnecting ${providerId}…`);
    try {
      const cleared = await clearRuntimeBackend(providerId);
      if (cleared === null) {
        setConnectedBackendIds((current) => current.filter((id) => id !== providerId));
        setBackendProviders((current) =>
          current.map((provider) =>
            provider.id === providerId
              ? {
                  ...provider,
                  authState:
                    provider.backendType === "acp" ? "install-required" : "needs-auth",
                  capabilities: []
                }
              : provider
          )
        );
        setBackendStatus(`${providerId} disconnected (preview).`);
        setLastAction(`${providerId} disconnected (preview)`);
        return;
      }

      await refreshBackendProviders();
      setBackendStatus(`${providerId} disconnected.`);
      setLastAction(`${providerId} disconnected`);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Could not disconnect ${providerId}.`;
      setBackendStatus(message);
      setLastAction(message);
    }
  };

  const dismissOnboarding = () => {
    if (!activeWorkspaceScope || connectedBackendIds.length === 0) {
      const message = "Connect and verify a model provider before entering Fable.";
      setBackendStatus(message);
      setLastAction(message);
      return;
    }
    setOnboardingDismissed(true);
    setOnboardingVersion(CURRENT_ONBOARDING_VERSION);
    setLastAction("Fable setup complete");
  };

  // Queue a backend-originated tool call until the user decides. This is
  // deliberately transient: a pending executor cannot survive an app restart,
  // and recording a deny/allow audit entry before a decision would be false.
  const recordBackendToolCall = (event: {
    callId: string;
    tool: string;
    arguments: string;
    approval: ApprovalRequest;
  }) => {
    setBackendToolApprovals((current) => {
      const existingIndex = current.findIndex(
        (approval) => approval.id === event.approval.id
      );
      if (existingIndex < 0) return [...current, event.approval];
      return current.map((approval, index) =>
        index === existingIndex ? event.approval : approval
      );
    });
    setLastAction(`Tool call from ${event.approval.service}: ${event.tool}`);
  };

  const clearBackendToolApprovals = () => {
    setBackendToolApprovals([]);
  };

  // A usable workspace, a verified provider, and explicit completion of the
  // first-run journey are all required. Persisted preview/local dismissal can
  // never bypass a missing provider.
  const onboardingRequired =
    !activeWorkspaceScope ||
    connectedBackendIds.length === 0 ||
    !onboardingDismissed ||
    onboardingVersion < CURRENT_ONBOARDING_VERSION;

  const runCommand = (command: string) => {
    const prompt = `${command} `;
    setComposerValue(prompt);
    setCommandOpen(false);
    setLastAction(`${command} command ready`);
    focusComposer(prompt);
  };

  // Composer picker bindings: the model picker drives request.model on the next
  // agent run; the approval preset maps its label onto a PermissionMode that
  // gates tool execution in the agent loop.
  const selectModel = (modelId: string) => {
    const chosen = modelOptions.find(
      (model) => model.id === modelId || model.modelId === modelId
    );
    setSelectedModelId(chosen?.id ?? "");
    setLastAction(
      chosen ? `${chosen.providerLabel} · ${chosen.label} selected` : "Model cleared"
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
        : permissionModeFor(label)
    );
    setLastAction(`Approval preset set to ${label}`);
  };

  const updateCustomApprovalSetting = (
    key: keyof CustomApprovalSettings,
    value: boolean
  ) => {
    setCustomApprovalSettings((current) => {
      const next = normalizeCustomApprovalSettings({ ...current, [key]: value });
      setPermissionLabel("Custom");
      setPermissionMode(resolvePermissionModeFromCustom(next));
      return next;
    });
    setLastAction("Custom approvals updated");
  };

  const approvalNeedsConfirmation = (
    approval: ApprovalRequest,
    modification?: ApprovalModification
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
    confirmationText?: string
  ) => {
    const connectorAction = preparedConnectorActions.find(
      (candidate) => candidate.approval.id === approval.id
    );
    if (connectorAction && (decision === "session" || decision === "rule")) {
      setLastAction("Connected app changes need a fresh approval each time.");
      return;
    }

    const request = {
      request: approval,
      decision,
      decidedAt: new Date().toISOString(),
      modification,
      confirmationText
    };

    try {
      const response = runtimeOrPreview(
        await resolveRuntimeApprovalRequest(request),
        () => resolveApprovalFallback(request),
        "Approvals require the desktop runtime."
      );

      setApprovalAudit((current) => prependAuditEntry(current, response.auditEntry));
      if (response.dismissed) {
        setDismissedApprovalIds((current) =>
          current.includes(approval.id) ? current : [...current, approval.id]
        );
      }
      if (response.grant?.scope === "session") {
        setSessionApprovalGrants((current) => [
          response.grant as ApprovalGrant,
          ...current.filter((grant) => grant.id !== response.grant?.id)
        ]);
      }
      if (response.grant?.scope === "rule") {
        setApprovalRules((current) => [
          response.grant as ApprovalGrant,
          ...current.filter((grant) => grant.id !== response.grant?.id)
        ]);
      }

      if (connectorAction) {
        const runtimeResult = await executeRuntimeConnectorAction({
          action: connectorAction,
          approval: request
        });
        const connectorResult = runtimeResult ?? resolveBrowserSessionAction({
          session: browserSession,
          action: connectorAction,
          decision,
          permissionMode,
          allowFixturePreview: ALLOW_PREVIEW_FALLBACKS
        });
        setPreparedConnectorActions((current) =>
          current.filter((candidate) => candidate.id !== connectorAction.id)
        );
        setConnectorStatus(connectorResult.message);
      }

      // Grant -> execute bridge: drive the matching pending tool call on the
      // shared approval gate so the agent-loop executor proceeds (grant) or
      // refuses (deny). Only approvals the shell registered as pending tool
      // calls are dispatched — a regular connector approval with no pending
      // entry is a no-op here. A deny never executes the tool.
      const gate = approvalGateRef.current;
      if (gate?.hasPending(approval.id)) {
        if (decision === "deny") {
          gate.resolveDeny(approval.id);
        } else if (decision === "once" || decision === "session" || decision === "rule" || decision === "modify") {
          gate.resolveGrant(approval.id);
        }
      }

      setBackendToolApprovals((current) =>
        current.filter((candidate) => candidate.id !== approval.id)
      );

      clearApprovalInteraction();
      setLastAction(
        decision === "modify"
          ? `Modified approval for ${approval.service}`
          : `${decision} recorded for ${approval.service}`
      );
    } catch (error) {
      setLastAction(
        error instanceof Error ? error.message : "Fable could not resolve that approval."
      );
    }
  };

  const requestApprovalDecision = (
    approval: ApprovalRequest,
    decision: ApprovalDecision,
    modification?: ApprovalModification
  ) => {
    if (decision !== "deny" && approvalNeedsConfirmation(approval, modification)) {
      setPendingApprovalConfirmation({ request: approval, decision, modification });
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
      consequence: approval.consequence
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
      consequence
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
      approvalConfirmationText
    );
  };

  const toggleSourcePin = (sourceId: string) => {
    setPinnedSourceIds((current) => {
      if (current.includes(sourceId)) {
        setLastAction("Source removed from pinned context");
        return current.filter((id) => id !== sourceId);
      }
      // Pinning must not bypass exclusion: a disabled source cannot be pinned,
      // and the source must belong to the current workspace + an authorized
      // (connected) connector. Unpinning is always allowed.
      const source = workspaceKnowledgeSources.find((entry) => entry.id === sourceId);
      if (!source) {
        setLastAction("That source is no longer available.");
        return current;
      }
      if (!isLiveSource(source)) {
        setLastAction("Disabled sources cannot be pinned.");
        return current;
      }
      if (!sourceIsAuthorized(source)) {
        setLastAction("Connect the source's service before pinning it.");
        return current;
      }
      setLastAction("Source pinned to workspace context");
      return [...current, sourceId];
    });
  };

  const createAgent = (input: Omit<FableAgentProfile, "id" | "threadId">) => {
    const id = `agent-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
    const created: FableAgentProfile = {
      ...input,
      id,
      icon: "agent",
      iconColor: /^#[0-9a-f]{6}$/i.test(input.iconColor) ? input.iconColor : "#865DFA"
    };
    setAgents((current) => [...current, created]);
    setActiveAgentId(id);
    setActiveItem(id);
    selectModel(created.modelId);
    selectPermissionLabel(created.permissionLabel);
    return created;
  };

  const updateAgent = (
    agentId: string,
    patch: Partial<Omit<FableAgentProfile, "id">>
  ) => {
    setAgents((current) => current.map((agent) =>
      agent.id === agentId ? { ...agent, ...patch } : agent
    ));
    if (agentId === activeAgentId) {
      if (patch.modelId !== undefined) selectModel(patch.modelId);
      if (patch.permissionLabel !== undefined) selectPermissionLabel(patch.permissionLabel);
    }
  };

  const selectAgent = (agentId: string) => {
    const selected = agents.find((agent) => agent.id === agentId);
    if (!selected) return;
    setActiveAgentId(agentId);
    setActiveItem(agentId);
    selectModel(selected.modelId);
    selectPermissionLabel(selected.permissionLabel);
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
        selectPermissionLabel(next.permissionLabel);
      }
    }
  };

  return {
    activeItem,
    setActiveItem,
    activeUtility,
    activePage,
    isChatView,
    activeThread,
    allThreads,
    agents,
    activeAgentId,
    createAgent,
    updateAgent,
    removeAgent,
    selectAgent,
    composerValue,
    setComposerValue,
    voiceEnabled,
    setVoiceEnabled,
    toggleVoice,
    setImportStatus,
    triggerAttach,
    triggerFolderImport,
    toolPickerOpen,
    commandOpen,
    importStatus,
    composerAttachments,
    knowledgeCitations,
    knowledgeSearchMode,
    composerRef,
    fileInputRef,
    folderInputRef,
    submitComposer,
    submitPrompt,
    removeComposerAttachment,
    handleLocalKnowledgeFileChange,
    handleComposerAttachmentChange,
    handleLocalKnowledgeFolderChange,
    focusComposer,
    useDirective,
    useConnector,
    runCommand,
    connectorManifests,
    browserSession,
    connectorAccounts,
    connectorStatus,
    connectorSearchResult,
    connectorImportedSources,
    connectConnector,
    disconnectConnector,
    refreshConnector,
    loadConnectorAccounts,
    switchConnectorAccount,
    searchConnector,
    importConnectorItem,
    prepareConnectorAction,
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
    saveTextToKnowledge,
    contextualDirectives,
    pinnedSourceIds,
    managedMemoryRecords,
    memoryDisabled,
    memoryState,
    editingMemoryId,
    editingMemoryDraft,
    memoryExportText,
    memoryStatus,
    setEditingMemoryDraft,
    toggleSourcePin,
    promoteSourceToMemory,
    startMemoryEdit,
    saveMemoryEdit,
    toggleMemoryPin,
    forgetMemory,
    toggleMemoryRecordDisabled,
    toggleMemoryDisabled,
    exportMemory,
    exportKnowledge,
    knowledgeExportText,
    cancelMemoryEdit,
    searchKnowledge: runKnowledgeSearch,
    refreshKnowledgeSource,
    toggleKnowledgeSourceDisabled,
    deleteKnowledgeSource,
    assembleKnowledgeContext,
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
    identityStatus,
    identityPending,
    accountWorkspaceStatus,
    accountWorkspacePending,
    signInIdentity,
    recoverIdentity,
    refreshIdentity,
    signOutIdentity,
    reconcileAccountWorkspace,
    createAccountWorkspace,
    selectAccountWorkspace,
    revokeAccountDevice,
    clearBackendToolApprovals,
    dismissOnboarding,
    lastAction,
    mobileNavOpen,
    setMobileNavOpen,
    startNewChat,
    openThread,
    setLastAction
  };
}

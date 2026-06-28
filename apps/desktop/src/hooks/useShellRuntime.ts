import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalAuditEntry,
  ApprovalDecision,
  ApprovalGrant,
  ApprovalModification,
  ApprovalRequest,
  BackendConsequentialEvent,
  BackendProvider,
  ConnectorActionKind,
  ConnectorActionRequest,
  ConnectorManifest,
  ConnectorSearchItem,
  ConnectorSearchRequest,
  ConnectorSearchResult,
  FirstWaveConnectorId,
  KnowledgeCitation,
  KnowledgeSource,
  LocalFileImport,
  MemoryControlState,
  MemoryPromotionRequest,
  MemoryRecord,
  PermissionMode,
  RuntimeSnapshot,
  ScheduledJob,
  ThreadSummary,
  WorkflowDefinition,
  WorkflowRun,
  NotificationRecord,
  WorkspaceDirective
} from "@fable/protocol";
import {
  FIRST_WAVE_CONNECTOR_IDS,
  importFixtureConnectorItem,
  importLocalTextFile,
  listBackendProviders,
  prepareFixtureConnectorAction,
  searchFixtureConnector,
  searchKnowledgeSources,
  missedOccurrences,
  nextOccurrence,
  shapeWorkflowNotification,
  type ToolApprovalGate,
  type LocalTextFileCandidate
} from "@fable/connectors";
import {
  DEFAULT_PERMISSION_LABEL,
  permissionLabelFor,
  permissionModeFor,
  resolveSelectedModel
} from "../lib/agent-run";
import {
  chatThreads,
  connectors,
  knowledgeSources,
  memoryRecords,
  pendingApprovals,
  projects,
  workspaceDirectives
} from "../data/workspace";
import {
  beginRuntimeConnectorOAuth,
  clearRuntimeConnectorAuth,
  clearRuntimeBackend,
  connectRuntimeBackend,
  exportRuntimeMemoryState,
  importRuntimeConnectorItem,
  importRuntimeLocalKnowledgeSource,
  listRuntimeConnectorStatuses,
  listRuntimeBackends,
  loadRuntimeApprovalAudit,
  loadRuntimeApprovalRules,
  loadRuntimeImportedKnowledgeSources,
  loadRuntimeMemoryState,
  loadRuntimeSnapshot,
  listRuntimeSchedulerJobs,
  listRuntimeWorkflowRuns,
  listRuntimeWorkflowDefinitions,
  listenRuntimeSchedulerRunRequest,
  enqueueRuntimeJobRun,
  reportRuntimeJobAttempt,
  saveRuntimeScheduledJob,
  saveRuntimeWorkflowDefinition,
  saveRuntimeWorkflowRun,
  setRuntimeJobStatus,
  deleteRuntimeScheduledJob,
  deliverRuntimeNotification,
  prepareRuntimeConnectorAction,
  promoteRuntimeKnowledgeSourceToMemory,
  recordRuntimeBackendEvent,
  refreshRuntimeConnectorHealth,
  resolveRuntimeApprovalRequest,
  saveRuntimeMemoryState,
  saveRuntimeSnapshot,
  searchRuntimeConnector,
  searchRuntimeKnowledgeSources
} from "../runtime";
import {
  MAX_IMPORTED_KNOWLEDGE_SOURCES,
  utilityItems
} from "../lib/constants";
import {
  EMPTY_APPROVAL_MODIFICATION,
  type WorkspacePage,
  type ApprovalModificationDraft,
  type PendingApprovalConfirmation,
  type PersistedShellState,
  type Schedule,
  type Weekday
} from "../lib/types";
import {
  importedSourceDirective,
  mergeKnowledgeSources,
  prependAuditEntry,
  readFileAsText,
  toSlug
} from "../lib/helpers";
import {
  encodeMemoryExportFallback,
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

/**
 * Owns all workspace shell state and the runtime-backed effects (snapshot
 * recovery, approval audit/rules, imported knowledge, memory). Returns the
 * state and callbacks the root component needs to render the shell, composer,
 * and context views.
 */

const defaultShellState: PersistedShellState = {
  activeItem: "new-chat",
  composerValue: "",
  voiceEnabled: false,
  approvalAudit: [],
  dismissedApprovalIds: [],
  approvalRules: [],
  schedules: [],
  pinnedSourceIds: knowledgeSources.filter((source) => source.pinned).map((source) => source.id),
  importedKnowledgeSources: [],
  memoryDisabled: false,
  memoryRecords,
  connectedBackendIds: [],
  // "" lets Fable pick the first available model; full-access mirrors the
  // composer's pre-existing default so behavior is unchanged until selected.
  selectedModelId: "",
  permissionMode: "full-access"
};

function isFirstWaveConnectorId(value: string): value is FirstWaveConnectorId {
  return (FIRST_WAVE_CONNECTOR_IDS as readonly string[]).includes(value);
}

export interface ShellRuntime {
  // navigation
  activeItem: string;
  setActiveItem: (value: string) => void;
  activeUtility: string | undefined;
  activePage: WorkspacePage | null;
  isChatView: boolean;
  activeThread: ThreadSummary | undefined;
  allThreads: ThreadSummary[];
  // composer
  composerValue: string;
  setComposerValue: (value: string) => void;
  voiceEnabled: boolean;
  toggleVoice: () => void;
  setImportStatus: (status: string | null) => void;
  triggerAttach: () => void;
  toolPickerOpen: boolean;
  commandOpen: boolean;
  importStatus: string | null;
  knowledgeCitations: KnowledgeCitation[];
  knowledgeSearchMode: string;
  composerRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  submitComposer: (event: FormEvent) => void;
  submitPrompt: (prompt: string) => void;
  handleLocalKnowledgeFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  focusComposer: (value: string) => void;
  useDirective: (directive: WorkspaceDirective) => void;
  useConnector: (connector: ConnectorManifest) => void;
  runCommand: (command: string) => void;
  // first-wave connectors
  connectorManifests: ConnectorManifest[];
  connectorStatus: string | null;
  connectorSearchResult: ConnectorSearchResult | null;
  connectorImportedSources: KnowledgeSource[];
  connectConnector: (connector: ConnectorManifest) => Promise<void>;
  disconnectConnector: (connectorId: string) => Promise<void>;
  refreshConnector: (connectorId: string) => Promise<void>;
  searchConnector: (request: ConnectorSearchRequest) => Promise<void>;
  importConnectorItem: (item: ConnectorSearchItem) => Promise<void>;
  prepareConnectorAction: (
    action: ConnectorActionKind,
    payload: Record<string, string>
  ) => Promise<void>;
  // approvals
  openApprovals: ApprovalRequest[];
  approvalAudit: ApprovalAuditEntry[];
  sessionApprovalGrants: ApprovalGrant[];
  approvalRules: ApprovalGrant[];
  editingApprovalId: string | null;
  approvalModificationDraft: ApprovalModificationDraft;
  pendingApprovalConfirmation: PendingApprovalConfirmation | null;
  approvalConfirmationText: string;
  setApprovalModificationDraft: (draft: ApprovalModificationDraft) => void;
  setApprovalConfirmationText: (value: string) => void;
  requestApprovalDecision: (
    approval: ApprovalRequest,
    decision: ApprovalDecision,
    modification?: ApprovalModification
  ) => void;
  startApprovalModify: (approval: ApprovalRequest) => void;
  saveApprovalModify: (approval: ApprovalRequest) => void;
  confirmApprovalDecision: () => void;
  clearApprovalInteraction: () => void;
  // knowledge + memory
  workspaceKnowledgeSources: KnowledgeSource[];
  contextualDirectives: WorkspaceDirective[];
  pinnedSourceIds: string[];
  managedMemoryRecords: MemoryRecord[];
  memoryDisabled: boolean;
  memoryState: MemoryControlState;
  editingMemoryId: string | null;
  editingMemoryDraft: Pick<MemoryRecord, "title" | "value">;
  memoryExportText: string;
  memoryStatus: string;
  setEditingMemoryDraft: (draft: Pick<MemoryRecord, "title" | "value">) => void;
  toggleSourcePin: (sourceId: string) => void;
  promoteSourceToMemory: (source: KnowledgeSource) => void;
  startMemoryEdit: (record: MemoryRecord) => void;
  saveMemoryEdit: (recordId: string) => void;
  toggleMemoryPin: (recordId: string) => void;
  forgetMemory: (recordId: string) => void;
  toggleMemoryDisabled: () => void;
  exportMemory: () => Promise<void>;
  cancelMemoryEdit: () => void;
  // schedules
  schedules: Schedule[];
  createSchedule: (input: { name: string; description: string; day: Weekday; time: string }) => void;
  editSchedule: (schedule: Schedule) => void;
  toggleSchedule: (schedule: Schedule) => void;
  deleteSchedule: (schedule: Schedule) => void;
  scheduledJobs: ScheduledJob[];
  workflowRuns: WorkflowRun[];
  notificationHistory: NotificationRecord[];
  pendingWorkflowRuns: Array<{ runId: string; jobId: string; prompt: string }>;
  runScheduleNow: (job: ScheduledJob) => void;
  completeWorkflowRun: (runId: string, ok: boolean, result?: string) => void;
  // agent-runtime backends
  backendProviders: BackendProvider[];
  connectedBackendIds: string[];
  backendStatus: string | null;
  onboardingRequired: boolean;
  connectBackend: (providerId: string, secret?: string) => Promise<void>;
  disconnectBackend: (providerId: string) => Promise<void>;
  /**
   * The connected native-API backend that owns the agent loop, if any. Drives
   * the composer's model picker and the native run path. Null when no native
   * backend is connected (the composer falls back to knowledge search).
   */
  connectedNativeBackend: BackendProvider | undefined;
  /** Models the composer's model picker may offer (from the connected backend). */
  selectableModels: BackendProvider["models"];
  /** The model id that should drive the next agent run (re-validated). */
  resolvedSelectedModelId: string;
  /** Persisted model selection (raw; prefer resolvedSelectedModelId at run time). */
  selectedModelId: string;
  selectModel: (modelId: string) => void;
  /** The current permission-level label shown in the composer. */
  permissionLabel: string;
  selectPermissionLabel: (label: string) => void;
  /**
   * Record a native-API model tool call as an approval audit entry. Model tool
   * calls never auto-execute — they surface here so the existing approval UI
   * handles the grant/rule/deny decision before Fable dispatches the tool.
   */
  recordBackendToolCall: (event: {
    callId: string;
    tool: string;
    arguments: string;
    approval: ApprovalRequest;
  }) => void;
  dismissOnboarding: () => void;
  // shell-level status
  lastAction: string;
  mobileNavOpen: boolean;
  setMobileNavOpen: (open: boolean | ((open: boolean) => boolean)) => void;
  startNewChat: () => void;
  openThread: (thread: ThreadSummary, label: string) => void;
  setLastAction: (action: string) => void;
}

export interface UseShellRuntimeOptions {
  /**
   * The shared approval gate the agent-loop executor awaits. When provided,
   * granting/denying a tool-call approval drives the matching pending tool call
   * on the gate so the executor proceeds or refuses — the grant -> execute
   * bridge. Omit for the pre-tool-execution behavior (no dispatch).
   */
  approvalGate?: ToolApprovalGate;
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
  const [approvalAudit, setApprovalAudit] = useState<ApprovalAuditEntry[]>(initialState.approvalAudit);
  const [dismissedApprovalIds, setDismissedApprovalIds] = useState<string[]>(initialState.dismissedApprovalIds);
  const [approvalRules, setApprovalRules] = useState<ApprovalGrant[]>(initialState.approvalRules);
  const [sessionApprovalGrants, setSessionApprovalGrants] = useState<ApprovalGrant[]>([]);
  const [editingApprovalId, setEditingApprovalId] = useState<string | null>(null);
  const [approvalModificationDraft, setApprovalModificationDraft] =
    useState<ApprovalModificationDraft>(EMPTY_APPROVAL_MODIFICATION);
  const [pendingApprovalConfirmation, setPendingApprovalConfirmation] =
    useState<PendingApprovalConfirmation | null>(null);
  const [approvalConfirmationText, setApprovalConfirmationText] = useState("");
  const [schedules, setSchedules] = useState<Schedule[]>(initialState.schedules);
  const [scheduledJobs, setScheduledJobs] = useState<ScheduledJob[]>([]);
  const [workflowDefinitions, setWorkflowDefinitions] = useState<WorkflowDefinition[]>([]);
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRun[]>([]);
  const [pendingWorkflowRuns, setPendingWorkflowRuns] = useState<
    Array<{ runId: string; jobId: string; prompt: string }>
  >([]);
  const [notificationHistory, setNotificationHistory] = useState<NotificationRecord[]>(() => {
    try {
      return JSON.parse(window.localStorage.getItem("fable.notification-history.v1") ?? "[]");
    } catch {
      return [];
    }
  });
  const [pinnedSourceIds, setPinnedSourceIds] = useState<string[]>(initialState.pinnedSourceIds);
  const [connectedBackendIds, setConnectedBackendIds] = useState<string[]>(
    initialState.connectedBackendIds
  );
  const [importedKnowledgeSources, setImportedKnowledgeSources] = useState<LocalFileImport[]>(
    initialState.importedKnowledgeSources
  );
  const [knowledgeCitations, setKnowledgeCitations] = useState<KnowledgeCitation[]>([]);
  const [knowledgeSearchMode, setKnowledgeSearchMode] = useState("lexical-fallback");
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [connectorManifests, setConnectorManifests] =
    useState<ConnectorManifest[]>(connectors);
  const [connectorStatus, setConnectorStatus] = useState<string | null>(null);
  const [connectorSearchResult, setConnectorSearchResult] =
    useState<ConnectorSearchResult | null>(null);
  const [connectorImportedSources, setConnectorImportedSources] = useState<KnowledgeSource[]>([]);
  const [preparedConnectorActions, setPreparedConnectorActions] =
    useState<ConnectorActionRequest[]>([]);
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
  const [runtimeSnapshotReady, setRuntimeSnapshotReady] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Agent-runtime backends. The Rust credential boundary resolves auth state
  // + capabilities; outside Tauri the preview registry is used so the onboarding
  // shell stays testable. `onboardingDismissed` lets users reach the preview
  // workspace without a connected backend.
  const [backendProviders, setBackendProviders] = useState<BackendProvider[]>(() =>
    listBackendProviders()
  );
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [backendStatus, setBackendStatus] = useState<string | null>(null);
  // Composer model + permission picker selections, persisted so the next run
  // uses them. The model is re-validated against the connected backend's
  // available models before each run (see resolveSelectedModel).
  const [selectedModelId, setSelectedModelId] = useState(initialState.selectedModelId);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(initialState.permissionMode);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const allThreads = useMemo(
    () => [...chatThreads, ...projects.flatMap((project) => project.threads)],
    []
  );
  const activeThread = allThreads.find((thread) => thread.id === activeItem);
  const activeUtility = utilityItems.find((item) => item.label === activeItem)?.label;
  // A page view is any first-class utility page or account page. When a page
  // is active the composer is hidden and the dedicated page renders instead.
  const activePage: WorkspacePage | null =
    activeUtility === "Knowledge" ||
    activeUtility === "Schedules" ||
    activeUtility === "Connectors"
      ? (activeUtility as WorkspacePage)
      : activeItem === "Profile" || activeItem === "Settings"
        ? activeItem
      : null;
  // Chat views: the default home, a selected thread/project, or a new chat.
  const isChatView = activePage === null;
  const workspaceKnowledgeSources = useMemo(
    () =>
      mergeKnowledgeSources(knowledgeSources, [
        ...connectorImportedSources,
        ...importedKnowledgeSources
      ]),
    [connectorImportedSources, importedKnowledgeSources]
  );
  // The native-API backend that owns the agent loop when one is connected. The
  // composer's model picker lists this backend's models; selecting one drives
  // request.model on the next agent run.
  const connectedNativeBackend = useMemo(
    () =>
      backendProviders.find(
        (provider) =>
          provider.backendType === "native-api" &&
          provider.authState === "connected" &&
          provider.capabilities.includes("streaming")
      ),
    [backendProviders]
  );
  const selectableModels = useMemo(
    () => connectedNativeBackend?.models ?? [],
    [connectedNativeBackend]
  );
  // The persisted selection is re-validated against the connected backend's
  // available models each render: keep it if still available, else fall back to
  // the first available model (or "" when none is available).
  const resolvedSelectedModelId = useMemo(
    () => resolveSelectedModel(selectableModels, selectedModelId),
    [selectableModels, selectedModelId]
  );
  const contextualDirectives = useMemo(
    () => [
      ...importedKnowledgeSources.slice(0, 2).map(importedSourceDirective),
      ...workspaceDirectives
    ].slice(0, 4),
    [importedKnowledgeSources]
  );
  const openApprovals = [...preparedConnectorActions.map((request) => request.approval), ...pendingApprovals]
    .filter((approval) => !dismissedApprovalIds.includes(approval.id));
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
      schedules,
      pinnedSourceIds,
      importedKnowledgeSources,
      memoryDisabled,
      memoryRecords: managedMemoryRecords,
      connectedBackendIds,
      selectedModelId,
      permissionMode
    }),
    [
      activeItem,
      approvalAudit,
      approvalRules,
      schedules,
      composerValue,
      connectedBackendIds,
      dismissedApprovalIds,
      importedKnowledgeSources,
      managedMemoryRecords,
      memoryDisabled,
      permissionMode,
      pinnedSourceIds,
      selectedModelId,
      voiceEnabled
    ]
  );

  useEffect(() => {
    persistShellState(shellState);
  }, [shellState]);

  useEffect(() => {
    window.localStorage.setItem(
      "fable.notification-history.v1",
      JSON.stringify(notificationHistory.slice(0, 200))
    );
  }, [notificationHistory]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      listRuntimeSchedulerJobs(),
      listRuntimeWorkflowDefinitions(),
      listRuntimeWorkflowRuns()
    ]).then(([jobs, definitions, runs]) => {
      if (!active) return;
      if (jobs) {
        const now = new Date();
        const recoveredJobs = jobs.map((job) => {
          if (job.status !== "active") return job;
          const previous = new Date(job.lastRunAt || job.createdAt);
          const missed = missedOccurrences(job.trigger, previous, now, job.missedRunPolicy);
          for (const occurrence of missed) {
            const scheduledAt = occurrence.toISOString();
            void enqueueRuntimeJobRun(
              job.id,
              `workflow-run-${toSlug(job.id)}-${toSlug(scheduledAt)}`,
              scheduledAt
            ).catch(() => undefined);
          }
          const nextRunAt = nextOccurrence(job.trigger, now)?.toISOString() ?? "";
          const recovered = { ...job, nextRunAt, updatedAt: now.toISOString() };
          if (nextRunAt) {
            void enqueueRuntimeJobRun(
              job.id,
              `workflow-run-${toSlug(job.id)}-${toSlug(nextRunAt)}`,
              nextRunAt
            ).catch(() => undefined);
          }
          void saveRuntimeScheduledJob(recovered);
          return recovered;
        });
        setScheduledJobs(recoveredJobs);
      }
      if (definitions) setWorkflowDefinitions(definitions);
      if (runs) {
        setWorkflowRuns(
          runs.map((record) => ({
            id: record.id,
            definitionId: record.definitionId,
            definitionVersion: record.definitionVersion,
            status: record.status,
            trigger: record.trigger,
            scheduledJobId: record.scheduledJobId,
            input: (record.input as Record<string, unknown>) ?? {},
            steps: (record.steps as WorkflowRun["steps"]) ?? [],
            failureReason: record.failureReason,
            idempotencyKey: record.idempotencyKey,
            startedAt: record.startedAt,
            updatedAt: record.updatedAt,
            finishedAt: record.finishedAt
          }))
        );
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    void listenRuntimeSchedulerRunRequest((event) => {
      if (active) queueWorkflowRun(event.jobId, event.runId);
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => {
      active = false;
      void unlisten?.();
    };
  }, [scheduledJobs, workflowDefinitions]);

  useEffect(() => {
    if (!runtimeSnapshotReady) {
      return;
    }

    void saveRuntimeSnapshot(shellStateToRuntimeSnapshot(shellState)).catch((error) => {
      setLastAction(error instanceof Error ? error.message : "Fable could not save runtime snapshot.");
    });
  }, [runtimeSnapshotReady, shellState]);

  useEffect(() => {
    let active = true;

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
        setSchedules(recovered.schedules);
        setPinnedSourceIds(recovered.pinnedSourceIds);
        setImportedKnowledgeSources(recovered.importedKnowledgeSources);
        setMemoryDisabled(recovered.memoryDisabled);
        setManagedMemoryRecords(recovered.memoryRecords);
        setConnectedBackendIds(recovered.connectedBackendIds);
        setSelectedModelId(recovered.selectedModelId);
        setPermissionMode(recovered.permissionMode);
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
  }, []);

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
  }, []);

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
  }, []);

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
  }, []);

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
  }, []);

  // Resolve agent-runtime backend auth state + capabilities from the Rust
  // credential boundary. Outside Tauri the preview registry is kept. Secrets
  // never reach this layer — only auth state and capabilities.
  useEffect(() => {
    let active = true;

    void listRuntimeConnectorStatuses().then((manifests) => {
      if (!active || !manifests) {
        return;
      }
      const runtimeById = new Map(manifests.map((manifest) => [manifest.id, manifest]));
      setConnectorManifests((current) =>
        current.map((manifest) => runtimeById.get(manifest.id) ?? manifest)
      );
    });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    void listRuntimeBackends().then((providers) => {
      if (!active || !providers) {
        return;
      }

      setBackendProviders(providers);
      const connectedIds = providers
        .filter((provider) => provider.authState === "connected")
        .map((provider) => provider.id);
      setConnectedBackendIds(connectedIds);
      if (connectedIds.length > 0) {
        setOnboardingDismissed(true);
      }
    });

    return () => {
      active = false;
    };
  }, []);

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
    setImportStatus("Choose a text, Markdown, JSON, CSV, or YAML file.");
    fileInputRef.current?.click();
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

  const importLocalKnowledgeFile = async (file: File) => {
    setImportStatus(`Reading ${file.name}...`);

    try {
      const content = await readFileAsText(file);
      const candidate: LocalTextFileCandidate = {
        name: file.name,
        content,
        sizeBytes: file.size,
        importedAt: new Date().toISOString()
      };
      const imported =
        (await importRuntimeLocalKnowledgeSource(candidate)) ?? importLocalTextFile(candidate);

      addImportedKnowledgeSource(imported);
      setImportStatus(`Imported ${imported.title}. It is pinned as untrusted knowledge.`);
      setLastAction(`Imported source: ${imported.title}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Fable could not import that file.";
      setImportStatus(message);
      setLastAction(message);
    }
  };

  const handleLocalKnowledgeFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (!file) {
      return;
    }

    void importLocalKnowledgeFile(file);
  };

  const runKnowledgeSearch = async (query: string) => {
    const runtimeResult = await searchRuntimeKnowledgeSources(query, workspaceKnowledgeSources, 3);
    const result = runtimeResult ?? searchKnowledgeSources(query, workspaceKnowledgeSources, 3);

    setKnowledgeCitations(result.citations);
    setKnowledgeSearchMode(result.mode);
    setLastAction(
      result.citations.length > 0
        ? `Found ${result.citations.length} cited workspace sources`
        : "No matching workspace sources found"
    );
  };

  const commitMemoryState = (state: MemoryControlState, status: string) => {
    setMemoryDisabled(state.disabled);
    setManagedMemoryRecords(state.records);
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
        setMemoryStatus(error instanceof Error ? error.message : "Fable could not save memory state.");
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

    const nextRecords = managedMemoryRecords.map((record) =>
      record.id === recordId
        ? {
            ...record,
            title,
            value,
            freshness: "Updated now",
            source: "Edited by Josh"
          }
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
    const nextRecords = managedMemoryRecords.filter((record) => record.id !== recordId);
    const removed = managedMemoryRecords.find((record) => record.id === recordId);
    setEditingMemoryId((current) => (current === recordId ? null : current));
    commitMemoryState(
      { disabled: memoryDisabled, records: nextRecords },
      removed ? `Forgot memory: ${removed.title}` : "Memory forgotten."
    );
  };

  const toggleMemoryPin = (recordId: string) => {
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
      const exported = (await exportRuntimeMemoryState(memoryState)) ?? encodeMemoryExportFallback(memoryState);
      setMemoryExportText(exported);
      setMemoryStatus("Memory export ready.");
    } catch (error) {
      setMemoryStatus(error instanceof Error ? error.message : "Fable could not export memory.");
    }
  };

  const promoteSourceToMemory = async (source: KnowledgeSource) => {
    const request: MemoryPromotionRequest = {
      source,
      decision: "once",
      decidedAt: new Date().toISOString(),
      state: memoryState
    };

    try {
      const response =
        (await promoteRuntimeKnowledgeSourceToMemory(request)) ?? promoteKnowledgeSourceFallback(request);
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

  const refreshConnector = async (connectorId: string) => {
    const connector = connectorManifests.find((manifest) => manifest.id === connectorId);
    if (!connector || !isFirstWaveConnectorId(connectorId)) {
      return;
    }

    try {
      const manifest = await refreshRuntimeConnectorHealth(connectorId);
      if (manifest) {
        replaceConnectorManifest(manifest);
        setConnectorStatus(`${connector.name} health refreshed.`);
      } else {
        setConnectorStatus(`${connector.name} fixture health is static preview data.`);
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
      const result =
        (await searchRuntimeConnector(request)) ?? searchFixtureConnector(request);
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
      const imported =
        (await importRuntimeConnectorItem(request)) ?? importFixtureConnectorItem(request);
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
      const fixtureRequest = prepareFixtureConnectorAction(action, payload);
      const prepared =
        (await prepareRuntimeConnectorAction(fixtureRequest)) ?? fixtureRequest;
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
  const connectBackend = async (providerId: string, secret = "preview-connection") => {
    setBackendStatus(`Connecting ${providerId}…`);
    try {
      const stored = await connectRuntimeBackend({ providerId, secret });
      if (stored === null) {
        // Preview mode (no Tauri runtime): record a local connection only.
        setConnectedBackendIds((current) =>
          current.includes(providerId) ? current : [...current, providerId]
        );
        setBackendProviders((current) =>
          current.map((provider) =>
            provider.id === providerId ? { ...provider, authState: "connected" } : provider
          )
        );
        setBackendStatus(`${providerId} connected (preview).`);
        setLastAction(`${providerId} connected (preview)`);
        return;
      }

      // Re-read the boundary so auth state + capabilities reflect the stored
      // credential (Rust resolves it; no secret crosses back).
      const refreshed = await listRuntimeBackends();
      if (refreshed) {
        setBackendProviders(refreshed);
        setConnectedBackendIds(
          refreshed
            .filter((provider) => provider.authState === "connected")
            .map((provider) => provider.id)
        );
      }
      setBackendStatus(`${providerId} connected.`);
      setLastAction(`${providerId} connected`);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Could not connect ${providerId}.`;
      setBackendStatus(message);
      setLastAction(message);
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

      const refreshed = await listRuntimeBackends();
      if (refreshed) {
        setBackendProviders(refreshed);
        setConnectedBackendIds(
          refreshed
            .filter((provider) => provider.authState === "connected")
            .map((provider) => provider.id)
        );
      }
      setBackendStatus(`${providerId} disconnected.`);
      setLastAction(`${providerId} disconnected`);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Could not disconnect ${providerId}.`;
      setBackendStatus(message);
      setLastAction(message);
    }
  };

  const dismissOnboarding = () => {
    setOnboardingDismissed(true);
    setLastAction("Onboarding skipped (preview)");
  };

  // Record a native-API model tool call as a backend consequential event. The
  // model wanted to run a tool; Fable records it (never auto-executes) so the
  // approval audit trail captures the request. The pre-shaped ApprovalRequest
  // is available to route through the approval UI before any tool dispatch.
  const recordBackendToolCall = (event: {
    callId: string;
    tool: string;
    arguments: string;
    approval: ApprovalRequest;
  }) => {
    const consequential: BackendConsequentialEvent = {
      providerId: event.approval.service,
      service: event.approval.service,
      action: event.approval.action,
      mode: event.approval.mode,
      riskLevel: event.approval.riskLevel,
      dataUsed: event.approval.dataUsed,
      consequence: event.approval.consequence,
      backendPreapproved: false
    };
    void recordRuntimeBackendEvent(consequential, new Date().toISOString()).then((entry) => {
      if (entry) {
        setApprovalAudit((current) => prependAuditEntry(current, entry));
      }
    });
    setLastAction(`Tool call from ${event.approval.service}: ${event.tool}`);
  };

  // The onboarding gate: required unless explicitly dismissed or skipped.
  const onboardingRequired = !onboardingDismissed;

  const runCommand = (command: string) => {
    const prompt = `${command} `;
    setComposerValue(prompt);
    setCommandOpen(false);
    setLastAction(`${command} command ready`);
    focusComposer(prompt);
  };

  // Composer picker bindings: the model picker drives request.model on the next
  // agent run; the permission-level picker maps its label onto a PermissionMode
  // that gates tool execution in the agent loop.
  const selectModel = (modelId: string) => {
    setSelectedModelId(modelId);
    const chosen = selectableModels.find((model) => model.id === modelId);
    setLastAction(chosen ? `${chosen.label} selected` : "Model cleared");
  };

  const selectPermissionLabel = (label: string) => {
    setPermissionMode(permissionModeFor(label));
    setLastAction(`Permission level set to ${label}`);
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
    const request = {
      request: approval,
      decision,
      decidedAt: new Date().toISOString(),
      modification,
      confirmationText
    };

    try {
      const response =
        (await resolveRuntimeApprovalRequest(request)) ?? resolveApprovalFallback(request);

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
      setLastAction("Source pinned to workspace context");
      return [...current, sourceId];
    });
  };

  const createSchedule = ({
    name,
    description,
    day,
    time
  }: {
    name: string;
    description: string;
    day: Weekday;
    time: string;
  }) => {
    const now = new Date();
    const id = `schedule-${toSlug(name)}-${toSlug(now.toISOString())}`;
    const schedule: Schedule = {
      id,
      name,
      description,
      day,
      time,
      enabled: true,
      createdAt: now.toISOString()
    };
    setSchedules((current) => [schedule, ...current]);
    const [hour, minute] = time.split(":").map(Number);
    const definition: WorkflowDefinition = {
      schemaVersion: 1,
      id: `workflow-${id}`,
      version: 1,
      name,
      description,
      steps: [{ kind: "prompt", id: "prompt", prompt: description }],
      notificationPrefs: {
        disableOs: false,
        enabledKinds: ["run-completed", "run-failed", "approval-needed"]
      },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    const trigger = {
      kind: "recurring" as const,
      rule: {
        frequency: "weekly" as const,
        interval: 1,
        byWeekday: [day],
        hour,
        minute,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      }
    };
    const job: ScheduledJob = {
      id,
      schemaVersion: 1,
      name,
      description,
      workflowDefinitionId: definition.id,
      trigger,
      missedRunPolicy: "run-once",
      status: "active",
      nextRunAt: nextOccurrence(trigger, now)?.toISOString() ?? "",
      lastRunAt: "",
      lastRunId: "",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    setWorkflowDefinitions((current) => [definition, ...current]);
    setScheduledJobs((current) => [job, ...current]);
    void saveRuntimeWorkflowDefinition(definition);
    void saveRuntimeScheduledJob(job);
    if (job.nextRunAt) {
      void enqueueRuntimeJobRun(
        job.id,
        `workflow-run-${toSlug(job.id)}-${toSlug(job.nextRunAt)}`,
        job.nextRunAt
      ).catch((error) => {
        setLastAction(error instanceof Error ? error.message : "Fable could not queue the schedule.");
      });
    }
    setLastAction(`Schedule created: ${name}`);
  };

  const toggleSchedule = (schedule: Schedule) => {
    setSchedules((current) =>
      current.map((entry) =>
        entry.id === schedule.id ? { ...entry, enabled: !entry.enabled } : entry
      )
    );
    const status: ScheduledJob["status"] = schedule.enabled ? "paused" : "active";
    const currentJob = scheduledJobs.find((job) => job.id === schedule.id);
    const updatedJob = currentJob
      ? {
          ...currentJob,
          status,
          nextRunAt:
            status === "active"
              ? nextOccurrence(currentJob.trigger, new Date())?.toISOString() ?? ""
              : "",
          updatedAt: new Date().toISOString()
        }
      : null;
    if (updatedJob) {
      setScheduledJobs((current) =>
        current.map((job) => (job.id === schedule.id ? updatedJob : job))
      );
      void saveRuntimeScheduledJob(updatedJob);
      if (status === "active" && updatedJob.nextRunAt) {
        void enqueueRuntimeJobRun(
          updatedJob.id,
          `workflow-run-${toSlug(updatedJob.id)}-${toSlug(updatedJob.nextRunAt)}`,
          updatedJob.nextRunAt
        ).catch(() => undefined);
      }
    }
    void setRuntimeJobStatus(schedule.id, status);
    setLastAction(`${schedule.name} ${schedule.enabled ? "paused" : "resumed"}`);
  };

  const editSchedule = (schedule: Schedule) => {
    const now = new Date();
    setSchedules((current) =>
      current.map((entry) => (entry.id === schedule.id ? schedule : entry))
    );
    const currentJob = scheduledJobs.find((job) => job.id === schedule.id);
    const currentDefinition = workflowDefinitions.find(
      (definition) => definition.id === currentJob?.workflowDefinitionId
    );
    if (!currentJob || !currentDefinition) return;
    const [hour, minute] = schedule.time.split(":").map(Number);
    const trigger = {
      kind: "recurring" as const,
      rule: {
        frequency: "weekly" as const,
        interval: 1,
        byWeekday: [schedule.day],
        hour,
        minute,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      }
    };
    const definition: WorkflowDefinition = {
      ...currentDefinition,
      version: currentDefinition.version + 1,
      name: schedule.name,
      description: schedule.description,
      steps: [{ kind: "prompt", id: "prompt", prompt: schedule.description }],
      updatedAt: now.toISOString()
    };
    const job: ScheduledJob = {
      ...currentJob,
      name: schedule.name,
      description: schedule.description,
      trigger,
      nextRunAt:
        currentJob.status === "active"
          ? nextOccurrence(trigger, now)?.toISOString() ?? ""
          : "",
      updatedAt: now.toISOString()
    };
    setWorkflowDefinitions((current) => [
      definition,
      ...current.filter((entry) => entry.id !== definition.id)
    ]);
    setScheduledJobs((current) =>
      current.map((entry) => (entry.id === job.id ? job : entry))
    );
    void saveRuntimeWorkflowDefinition(definition);
    void saveRuntimeScheduledJob(job);
    if (job.nextRunAt) {
      void enqueueRuntimeJobRun(
        job.id,
        `workflow-run-${toSlug(job.id)}-${toSlug(job.nextRunAt)}`,
        job.nextRunAt
      ).catch(() => undefined);
    }
    setLastAction(`Schedule updated: ${schedule.name}`);
  };

  const deleteSchedule = (schedule: Schedule) => {
    setSchedules((current) => current.filter((entry) => entry.id !== schedule.id));
    setScheduledJobs((current) => current.filter((entry) => entry.id !== schedule.id));
    void deleteRuntimeScheduledJob(schedule.id);
    setLastAction(`Schedule deleted: ${schedule.name}`);
  };

  function queueWorkflowRun(jobId: string, runId: string) {
    const job = scheduledJobs.find((candidate) => candidate.id === jobId);
    if (!job || job.status !== "active") return;
    const definition = workflowDefinitions.find(
      (candidate) => candidate.id === job.workflowDefinitionId
    );
    const prompt =
      definition?.steps.find(
        (step): step is Extract<typeof step, { kind: "prompt" | "agent" }> =>
          step.kind === "prompt" || step.kind === "agent"
      )?.prompt ?? job.description;
    const now = new Date().toISOString();
    const run: WorkflowRun = {
      id: runId,
      definitionId: job.workflowDefinitionId,
      definitionVersion: definition?.version ?? 1,
      status: "running",
      trigger: "schedule",
      scheduledJobId: jobId,
      input: {},
      steps: [{ stepId: "prompt", status: "running", input: { prompt }, startedAt: now }],
      idempotencyKey: `schedule:${jobId}:${runId}`,
      startedAt: now,
      updatedAt: now
    };
    setWorkflowRuns((current) => [run, ...current.filter((entry) => entry.id !== runId)]);
    setPendingWorkflowRuns((current) =>
      current.some((entry) => entry.runId === runId)
        ? current
        : [...current, { runId, jobId, prompt }]
    );
    void saveRuntimeWorkflowRun(run);
    void reportRuntimeJobAttempt(runId, {
      runId,
      status: "running",
      attemptNumber: 1,
      startedAt: now
    });
  }

  const runScheduleNow = (job: ScheduledJob) => {
    const now = new Date().toISOString();
    const runId = `workflow-run-${toSlug(job.id)}-${Date.now()}`;
    void enqueueRuntimeJobRun(job.id, runId, now).then((queued) => {
      if (!queued) queueWorkflowRun(job.id, runId);
    }).catch((error) => {
      setLastAction(error instanceof Error ? error.message : "Fable could not queue that run.");
    });
    setLastAction(`Queued ${job.name} to run now`);
  };

  const completeWorkflowRun = (runId: string, ok: boolean, result = "") => {
    const finishedAt = new Date().toISOString();
    const existing = workflowRuns.find((run) => run.id === runId);
    if (!existing) return;
    const completed: WorkflowRun = {
      ...existing,
      status: ok ? "completed" : "failed",
      steps: existing.steps.map((step) =>
        step.status === "running"
          ? {
              ...step,
              status: ok ? "succeeded" : "failed",
              output: ok ? result : undefined,
              error: ok ? undefined : result || "Agent run failed.",
              finishedAt
            }
          : step
      ),
      failureReason: ok ? undefined : result || "Agent run failed.",
      updatedAt: finishedAt,
      finishedAt
    };
    setWorkflowRuns((current) =>
      current.map((run) => (run.id === runId ? completed : run))
    );
    setPendingWorkflowRuns((current) => current.filter((run) => run.runId !== runId));
    const scheduledJob = scheduledJobs.find((job) => job.id === completed.scheduledJobId);
    const nextRunAt =
      scheduledJob?.status === "active"
        ? nextOccurrence(scheduledJob.trigger, new Date(finishedAt))?.toISOString() ?? ""
        : "";
    const updatedJob = scheduledJob
      ? {
          ...scheduledJob,
          lastRunAt: finishedAt,
          lastRunId: runId,
          nextRunAt,
          updatedAt: finishedAt
        }
      : null;
    if (updatedJob) {
      setScheduledJobs((current) =>
        current.map((job) => (job.id === updatedJob.id ? updatedJob : job))
      );
      void saveRuntimeScheduledJob(updatedJob);
      if (nextRunAt) {
        void enqueueRuntimeJobRun(
          updatedJob.id,
          `workflow-run-${toSlug(updatedJob.id)}-${toSlug(nextRunAt)}`,
          nextRunAt
        ).catch(() => undefined);
      }
    }
    void saveRuntimeWorkflowRun(completed);
    void reportRuntimeJobAttempt(runId, {
      runId,
      status: ok ? "succeeded" : "failed",
      attemptNumber: 1,
      startedAt: existing.startedAt,
      finishedAt,
      error: ok ? undefined : completed.failureReason
    });
    const definition = workflowDefinitions.find(
      (candidate) => candidate.id === completed.definitionId
    );
    const notification = shapeWorkflowNotification({
      id: `notification-${runId}`,
      kind: ok ? "run-completed" : "run-failed",
      run: completed,
      prefs: definition?.notificationPrefs,
      createdAt: finishedAt
    });
    setNotificationHistory((current) => [
      notification,
      ...current.filter((entry) => entry.id !== notification.id)
    ].slice(0, 200));
    if (!notification.suppressed) void deliverRuntimeNotification(notification);
  };

  return {
    activeItem,
    setActiveItem,
    activeUtility,
    activePage,
    isChatView,
    activeThread,
    allThreads,
    composerValue,
    setComposerValue,
    voiceEnabled,
    toggleVoice,
    setImportStatus,
    triggerAttach,
    toolPickerOpen,
    commandOpen,
    importStatus,
    knowledgeCitations,
    knowledgeSearchMode,
    composerRef,
    fileInputRef,
    submitComposer,
    submitPrompt,
    handleLocalKnowledgeFileChange,
    focusComposer,
    useDirective,
    useConnector,
    runCommand,
    connectorManifests,
    connectorStatus,
    connectorSearchResult,
    connectorImportedSources,
    connectConnector,
    disconnectConnector,
    refreshConnector,
    searchConnector,
    importConnectorItem,
    prepareConnectorAction,
    openApprovals,
    approvalAudit,
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
    toggleMemoryDisabled,
    exportMemory,
    cancelMemoryEdit,
    schedules,
    createSchedule,
    editSchedule,
    toggleSchedule,
    deleteSchedule,
    scheduledJobs,
    workflowRuns,
    notificationHistory,
    pendingWorkflowRuns,
    runScheduleNow,
    completeWorkflowRun,
    backendProviders,
    connectedBackendIds,
    backendStatus,
    onboardingRequired,
    connectBackend,
    disconnectBackend,
    connectedNativeBackend,
    selectableModels,
    resolvedSelectedModelId,
    selectedModelId,
    selectModel,
    permissionLabel: permissionLabelFor(permissionMode) || DEFAULT_PERMISSION_LABEL,
    selectPermissionLabel,
    recordBackendToolCall,
    dismissOnboarding,
    lastAction,
    mobileNavOpen,
    setMobileNavOpen,
    startNewChat,
    openThread,
    setLastAction
  };
}

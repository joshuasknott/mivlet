import type * as React from "react";
import type { ChangeEvent, FormEvent } from "react";
import type {
  AccountWorkspaceStatus, ActionHistoryEvent, ApprovalAuditEntry, ApprovalDecision, ApprovalGrant, ApprovalModification,
  ApprovalRequest, BackendProvider, BackendVerifyResult, BrowserSessionState, ConnectorActionKind,
  ConnectorAccountOption, ConnectorManifest, ConnectorSearchItem, ConnectorSearchRequest,
  ConnectorSearchResult, CustomApprovalSettings, FableCommandRequest, FableCommandResult,
  FableAgentProfile,
  IdentityStatus, KnowledgeCitation, KnowledgeSource, LocalFileImport, MemoryControlState,
  MemoryRecord, MissedRunPolicy, NotificationRecord, PermissionMode, ScheduledExecutionRoute,
  PreparedRunContext, ScheduledJob, SchedulerQueueEntry, ScheduleTrigger, ThreadSummary, WorkflowDefinition,
  WorkflowRun, WorkspaceDirective, WorkspaceGoal, WorkspacePlan
} from "@fable/protocol";
import type { ToolApprovalGate } from "@fable/connectors";
import type { ModelDiscoveryOutcome } from "../../lib/backend-state";
import type { ProviderModelOption } from "../../lib/provider-models";
import type { ProjectMemoryRunContext } from "../../lib/agent-run";
import type { ApprovalModificationDraft, ComposerAttachment, PendingApprovalConfirmation, Schedule, Weekday, WorkspacePage } from "../../lib/types";

export interface ShellRuntime {
  // navigation
  activeItem: string;
  setActiveItem: (value: string) => void;
  activeUtility: string | undefined;
  activePage: WorkspacePage | null;
  /**
   * A pending Run History job filter, set when navigating from a schedule's
   * "View runs" link. Run History consumes then clears it on mount so the link
   * is one-shot — the recurring definition → executions navigation target.
   */
  runHistoryJobId: string | null;
  /** Open Run History pre-filtered to a schedule's executions. */
  openRunHistoryForJob: (jobId: string) => void;
  /** Clear the one-shot Run History job filter (consumed on mount). */
  clearRunHistoryJobId: () => void;
  isChatView: boolean;
  activeThread: ThreadSummary | undefined;
  allThreads: ThreadSummary[];
  agents: FableAgentProfile[];
  activeAgentId: string;
  createAgent: (input: Omit<FableAgentProfile, "id" | "threadId">) => FableAgentProfile;
  updateAgent: (agentId: string, patch: Partial<Omit<FableAgentProfile, "id">>) => void;
  removeAgent: (agentId: string) => void;
  selectAgent: (agentId: string) => void;
  // composer
  composerValue: string;
  setComposerValue: (value: string) => void;
  voiceEnabled: boolean;
  setVoiceEnabled: (enabled: boolean) => void;
  toggleVoice: () => void;
  setImportStatus: (status: string | null) => void;
  triggerAttach: () => void;
  toolPickerOpen: boolean;
  commandOpen: boolean;
  importStatus: string | null;
  composerAttachments: ComposerAttachment[];
  knowledgeCitations: KnowledgeCitation[];
  knowledgeSearchMode: string;
  composerRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  folderInputRef: React.MutableRefObject<HTMLInputElement | null>;
  submitComposer: (event: FormEvent) => void;
  submitPrompt: (prompt: string) => void;
  removeComposerAttachment: (attachmentId: string) => void;
  handleLocalKnowledgeFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  handleComposerAttachmentChange: (event: ChangeEvent<HTMLInputElement>) => void;
  handleLocalKnowledgeFolderChange: (event: ChangeEvent<HTMLInputElement>) => void;
  triggerFolderImport: () => void;
  focusComposer: (value: string) => void;
  useDirective: (directive: WorkspaceDirective) => void;
  useConnector: (connector: ConnectorManifest) => void;
  runCommand: (command: string) => void;
  // first-wave connectors
  connectorManifests: ConnectorManifest[];
  browserSession: BrowserSessionState;
  connectorAccounts: Record<string, ConnectorAccountOption[]>;
  connectorStatus: string | null;
  connectorSearchResult: ConnectorSearchResult | null;
  connectorImportedSources: KnowledgeSource[];
  connectConnector: (connector: ConnectorManifest) => Promise<void>;
  disconnectConnector: (connectorId: string) => Promise<void>;
  refreshConnector: (connectorId: string) => Promise<void>;
  loadConnectorAccounts: (connectorId: string) => Promise<void>;
  switchConnectorAccount: (connectorId: string, accountId: string) => Promise<void>;
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
  saveTextToKnowledge: (title: string, content: string) => Promise<boolean>;
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
  /** Soft-disable a single memory: excluded from retrieval/context/export, but stays in management views. */
  toggleMemoryRecordDisabled: (recordId: string) => void;
  toggleMemoryDisabled: () => void;
  exportMemory: () => Promise<void>;
  /**
   * Export all current-workspace knowledge (live sources + live memories) as
   * plain text. Excludes disabled sources, forgotten/disabled memories,
   * secrets, connector tokens, and raw audit payloads. Resolves to the export
   * text and surfaces it through `knowledgeExportText`.
   */
  exportKnowledge: () => Promise<void>;
  knowledgeExportText: string;
  cancelMemoryEdit: () => void;
  searchKnowledge: (query: string) => Promise<void>;
  refreshKnowledgeSource: (sourceId: string, file?: File) => Promise<void>;
  toggleKnowledgeSourceDisabled: (sourceId: string) => void;
  /** Permanently remove a source from search, citations, pins, and context. */
  deleteKnowledgeSource: (sourceId: string) => void;
  /**
   * Assemble context for the authenticated active member. Fails closed when
   * the active workspace has no matching member instead of widening scope.
   */
  assembleKnowledgeContext: (query: string, context?: ProjectMemoryRunContext) => Promise<PreparedRunContext>;
  // schedules
  schedules: Schedule[];
  createSchedule: (input: { name: string; description: string; day: Weekday; time: string }) => void;
  toggleSchedule: (job: ScheduledJob) => void;
  deleteSchedule: (job: ScheduledJob) => Promise<void>;
  /**
   * Create a durable scheduled job from a fully-formed trigger (daily/weekly/
   * monthly/once). The Schedules UI uses this so the form can express every
   * recurrence the /schedule command supports. Returns the created job, or
   * throws when the captured permission profile blocks the mutation.
   */
  createScheduleFromTrigger: (input: {
    name: string;
    description: string;
    trigger: ScheduleTrigger;
    missedRunPolicy?: MissedRunPolicy;
    /** Connected connector ids whose data the workflow should read first. */
    connectorIds?: string[];
  }) => ScheduledJob;
  /**
   * Create scheduled work through the currently fenced writer. Before cutover
   * this creates a legacy schedule; after cutover it creates a canonical
   * Routine with the same time semantics.
   */
  createScheduledWork: (input: {
    name: string;
    description: string;
    trigger: ScheduleTrigger;
    missedRunPolicy?: MissedRunPolicy;
    connectorIds?: string[];
  }) => Promise<{ id: string; writer: "legacy" | "routine" }>;
  /** Transient chat-to-Routine draft; never persisted until the user saves. */
  pendingRoutineDraft: { title: string; instruction: string } | null;
  openRoutineDraft: (draft: { title: string; instruction: string }) => void;
  clearRoutineDraft: () => void;
  /**
   * Edit an existing job's name/prompt/trigger in place. Reuses the durable
   * store path and re-enqueues the next occurrence. The Schedules UI uses this
   * so edits can change the recurrence frequency, not just the weekday.
   */
  editScheduleFromTrigger: (input: {
    jobId: string;
    name: string;
    description: string;
    trigger: ScheduleTrigger;
    missedRunPolicy?: MissedRunPolicy;
    /** Connected connector ids whose data the workflow should read first. */
    connectorIds?: string[];
  }) => Promise<void>;
  // goals + plans (structured Fable state created by /goal and /plan)
  goals: WorkspaceGoal[];
  plans: WorkspacePlan[];
  createGoal: (input: { title: string; statement: string }) => Promise<WorkspaceGoal>;
  createPlan: (input: { title: string; steps: string[]; goalId?: string }) => WorkspacePlan;
  /** Execute a parsed Fable command; returns the result + any follow-up prompt. */
  runFableCommand: (
    request: FableCommandRequest,
    options?: { backendConnected?: boolean; activeGoalId?: string; stopCurrentWork?: () => Promise<boolean> }
  ) => Promise<FableCommandResult>;
  scheduledJobs: ScheduledJob[];
  workflowRuns: WorkflowRun[];
  notificationHistory: NotificationRecord[];
  pendingWorkflowRuns: Array<{
    runId: string;
    jobId: string;
    prompt: string;
    definition: WorkflowDefinition;
    previous?: WorkflowRun;
    leaseToken?: string;
    attemptNumber?: number;
    execution?: ScheduledExecutionRoute;
    routineDriver?: {
      projectId?: string;
      occurrenceId: string;
      writerEpoch: number;
    };
  }>;
  runScheduleNow: (job: ScheduledJob) => void;
  completeWorkflowRun: (
    runId: string,
    ok: boolean,
    result?: string,
    authoritativeRun?: WorkflowRun
  ) => void;
  /** Cancel a queued/leased/running scheduled run. */
  cancelScheduledRun: (runId: string) => void;
  /** The durable scheduler queue (Rust authority), surfaced for the Schedules UI. */
  schedulerQueue: SchedulerQueueEntry[];
  /** Re-fetch the scheduler queue from Rust (poll on demand). */
  refreshSchedulerQueue: () => void;
  /** True once persisted scheduled jobs have been hydrated from the Rust store. */
  schedulesReady: boolean;
  /** Error from the schedule hydration query, if Rust could not load the domain. */
  scheduleLoadError: string | null;
  /** Retry the schedule hydration query without depending on network state. */
  retryScheduleLoad: () => void;
  /** Versioned workflow definitions, for linking runs to their source workflow. */
  workflowDefinitions: WorkflowDefinition[];
  /**
   * Re-fetch persisted workflow runs from the Rust authority and merge them into
   * the in-memory run list. Used by Run History so the list reflects durable
   * history rather than only the runs created this session.
   */
  refreshWorkflowRuns: () => Promise<void>;
  /** Run ids currently being retried; UI shows a pending state per id. */
  retryingRunIds: string[];
  /**
   * Retry a failed/blocked/cancelled run by re-queuing its job occurrence.
   * Guards: only runs with a scheduled job that is still active can be retried.
   * Reports success/failure through `lastAction` and tracks pending state in
   * `retryingRunIds` until the queue acknowledges.
   */
  retryWorkflowRun: (runId: string) => void;
  // agent-runtime backends
  backendProviders: BackendProvider[];
  connectedBackendIds: string[];
  backendStatus: string | null;
  onboardingRequired: boolean;
  connectBackend: (providerId: string, secret?: string) => Promise<void>;
  /**
   * Verified connect path used by onboarding + Settings. Stores the key, then
   * verifies it against the provider inside the Rust boundary (the secret never
   * returns to JS). Returns the verify outcome so the UI can surface useful
   * errors (auth-failed/offline/unsupported/failed) and reflect state. On
   * `auth-failed` the bad key is cleared; on the transient outcomes the stored
   * key is retained so the user can retry.
   */
  connectBackendWithVerify: (
    providerId: string,
    secret: string
  ) => Promise<BackendVerifyResult>;
  /** Re-check a configured credential or provider-owned runtime without collecting a secret. */
  checkBackendConnection: (providerId: string) => Promise<BackendVerifyResult>;
  disconnectBackend: (providerId: string) => Promise<void>;
  /** Re-probe provider-owned runtimes after an install or sign-in completes. */
  refreshBackendProviders: () => Promise<BackendProvider[] | null>;
  /**
   * Per-provider model-discovery lifecycle (idle/loading/success/empty/offline/
   * unsupported/failed). A runtime condition layered on top of auth state: a
   * connected provider whose discovery is offline/failed is "connected but
   * degraded" — the key is fine, the model list just can't be confirmed. Idle
   * means discovery has not run for that provider yet.
   */
  modelDiscoveryByProvider: Record<string, ModelDiscoveryOutcome>;
  /**
   * Re-run model discovery for a connected provider and update its lifecycle.
   * Recoverable: surfaces a fresh model list or a retryable failure. No-op
   * outside the Tauri runtime (preview/fixture mode).
   */
  refreshModels: (providerId: string) => Promise<void>;
  /** All connected backends Fable can actually run, in provider registry order. */
  connectedAgentBackends: BackendProvider[];
  /** The backend owning the selected model and therefore the next interactive run. */
  connectedAgentBackend: BackendProvider | undefined;
  /** Active backend models using their provider wire ids. */
  selectableModels: BackendProvider["models"];
  /** Provider-aware choices shown by the composer across every connected backend. */
  modelOptions: ProviderModelOption[];
  /** The provider model id that should drive the next agent run (re-validated). */
  resolvedSelectedModelId: string;
  /** The collision-safe picker id corresponding to `resolvedSelectedModelId`. */
  resolvedModelOptionId: string;
  /** Persisted model selection (raw; prefer resolvedSelectedModelId at run time). */
  selectedModelId: string;
  selectModel: (modelId: string) => void;
  /** Resolved internal approval mode used by the agent loop. */
  permissionMode: PermissionMode;
  /** The current approval preset label shown in the composer. */
  permissionLabel: string;
  selectPermissionLabel: (label: string) => void;
  /** Plain-language Custom approval preferences. */
  customApprovalSettings: CustomApprovalSettings;
  updateCustomApprovalSetting: (
    key: keyof CustomApprovalSettings,
    value: boolean
  ) => void;
  /**
   * Queue a backend-originated tool call for the shared approval UI. Model tool
   * calls never auto-execute — they surface here so the existing approval UI
   * calls are audited only after the user decides, before Fable dispatches the tool.
   */
  recordBackendToolCall: (event: {
    callId: string;
    tool: string;
    arguments: string;
    approval: ApprovalRequest;
  }) => void;
  /** Remove cancelled backend tool calls from the transient approval queue. */
  clearBackendToolApprovals: () => void;
  /**
   * Fable account identity. It remains separate from connector OAuth and from
   * agent/backend credentials while the configuration-gated foundation is
   * being replaced by the required hosted sign-in flow.
   */
  identityStatus: IdentityStatus;
  identityPending: boolean;
  accountWorkspaceStatus: AccountWorkspaceStatus;
  accountWorkspacePending: boolean;
  signInIdentity: () => Promise<void>;
  recoverIdentity: () => Promise<void>;
  refreshIdentity: () => Promise<void>;
  signOutIdentity: () => Promise<void>;
  reconcileAccountWorkspace: () => Promise<void>;
  createAccountWorkspace: (name: string) => Promise<void>;
  selectAccountWorkspace: (fableWorkspaceId: string) => Promise<void>;
  revokeAccountDevice: (deviceId: string) => Promise<void>;
  /**
   * Inspectable action history (model calls, connector actions, tool/shell
   * actions, web actions, approvals, schedules, blocked policy decisions).
   * Audit observes actions and never carries secrets. Surfaced for the
   * Settings / Privacy / History view.
   */
  actionHistory: ActionHistoryEvent[];
  /** Re-fetch action history from the Rust store (poll on demand). */
  refreshActionHistory: () => void;
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

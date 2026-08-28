import type * as React from "react";
import type { ChangeEvent, FormEvent } from "react";
import type {
  AccountWorkspaceStatus, ActionHistoryEvent, ApprovalAuditEntry, ApprovalDecision, ApprovalGrant, ApprovalModification,
  ApprovalRequest, BackendProvider, BackendVerifyResult, BrowserSessionState, ConnectorActionKind,
  ConnectorAccountOption, ConnectorManifest, ConnectorSearchItem, ConnectorSearchRequest,
  ConnectorSearchResult, CustomApprovalSettings,
  FableAgentProfile,
  IdentityStatus, KnowledgeCitation, KnowledgeSource, MemoryControlState,
  MemoryRecord, PermissionMode, PreparedExecutionContext, ThreadSummary, WorkspaceDirective
} from "@fable/protocol";
import type { ToolApprovalGate } from "@fable/connectors";
import type { ModelDiscoveryOutcome } from "../../lib/backend-state";
import type { ProviderModelOption } from "../../lib/provider-models";
import type { KnowledgeRunContext } from "../../lib/agent-run";
import type { ApprovalModificationDraft, ComposerAttachment, PendingApprovalConfirmation, WorkspacePage } from "../../lib/types";

export interface ShellRuntime {
  // navigation
  activeItem: string;
  setActiveItem: (value: string) => void;
  activeUtility: string | undefined;
  activePage: WorkspacePage | null;
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
  assembleKnowledgeContext: (query: string, context?: KnowledgeRunContext) => Promise<PreparedExecutionContext>;
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
  /** Start a provider-supported browser sign-in without exposing OAuth material to React. */
  startBackendBrowserLogin: (providerId: string) => Promise<BackendVerifyResult>;
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
   * actions, web actions, approvals, and blocked policy decisions).
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

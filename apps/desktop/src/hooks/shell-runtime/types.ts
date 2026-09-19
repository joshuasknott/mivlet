import type {
  AccountWorkspaceStatus,
  ActionHistoryEvent,
  ApprovalAuditEntry,
  ApprovalDecision,
  ApprovalGrant,
  ApprovalModification,
  ApprovalRequest,
  BackendProvider,
  BackendVerifyResult,
  ConnectorAccountOption,
  ConnectorManifest,
  CustomApprovalSettings,
  MivletAgentProfile,
  IdentityStatus,
  KnowledgeSource,
  MemoryControlState,
  MemoryRecord,
  PermissionMode,
  PreparedExecutionContext,
} from "@mivlet/protocol";
import type {
  ToolApprovalGate,
} from "@mivlet/connectors";
import type {
  ModelDiscoveryOutcome,
} from "../../lib/backend-state";
import type {
  ProviderModelOption,
} from "../../lib/provider-models";
import type {
  KnowledgeRunContext,
} from "../../lib/agent-run";
import type {
  ApprovalModificationDraft,
  PendingApprovalConfirmation,
} from "../../lib/types";

export interface ShellRuntime {
  flushSnapshot: () => Promise<void>;
  // navigation
  activeItem: string;
  setActiveItem: (value: string) => void;

  agents: MivletAgentProfile[];
  activeAgentId: string;
  createAgent: (input: Omit<MivletAgentProfile, "id" | "threadId">) => MivletAgentProfile;
  updateAgent: (agentId: string, patch: Partial<Omit<MivletAgentProfile, "id">>) => void;
  removeAgent: (agentId: string) => void;

  // voice and imports

  voiceEnabled: boolean;
  voiceProvider: "browser" | "openai";
  setVoiceProvider: (provider: "browser" | "openai") => void;
  setVoiceEnabled: (enabled: boolean) => void;
  toggleVoice: () => void;
  setImportStatus: (status: string | null) => void;

  importStatus: string | null;

  // connected apps
  connectorManifests: ConnectorManifest[];
  refreshConnectorStatuses: () => Promise<ConnectorManifest[] | null>;
  connectorAccounts: Record<string, ConnectorAccountOption[]>;
  connectorStatus: string | null;
  connectorImportedSources: KnowledgeSource[];
  connectConnector: (connector: ConnectorManifest) => Promise<void>;
  disconnectConnector: (connectorId: string) => Promise<void>;
  refreshConnector: (connectorId: string) => Promise<void>;
  loadConnectorAccounts: (connectorId: string) => Promise<void>;
  switchConnectorAccount: (connectorId: string, accountId: string) => Promise<void>;
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
  importKnowledgeFile: (file: File, decodedContent?: string) => Promise<string | null>;
  pinnedSourceIds: string[];
  managedMemoryRecords: MemoryRecord[];
  memoryDisabled: boolean;
  memoryState: MemoryControlState;
  memoryExportText: string;
  memoryStatus: string;
  toggleMemoryPin: (recordId: string) => void;
  forgetMemory: (recordId: string) => Promise<void>;
  correctMemory: (recordId: string, title: string, value: string, expectedUpdatedAt?: string) => Promise<void>;
  /** Soft-disable a single memory: excluded from retrieval/context/export, but stays in management views. */
  toggleMemoryRecordDisabled: (recordId: string) => Promise<void>;
  toggleMemoryDisabled: () => Promise<void>;
  exportMemory: () => Promise<void>;
  /**
   * Assemble context for the authenticated active member. Fails closed when
   * the active workspace has no matching member instead of widening scope.
   */
  assembleConversationContext: (query: string, context?: KnowledgeRunContext) => Promise<PreparedExecutionContext>;
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
  /** All connected backends Mivlet can actually run, in provider registry order. */
  connectedAgentBackends: BackendProvider[];
  /** The backend owning the selected model and therefore the next interactive run. */
  connectedAgentBackend: BackendProvider | undefined;
  /** Active backend models using their provider wire ids. */
  selectableModels: BackendProvider["models"];
  /** Provider-aware choices shown by the composer across every connected backend. */
  modelOptions: ProviderModelOption[];
  allModelOptions: ProviderModelOption[];
  hiddenModelIds: string[];
  setModelVisible: (modelId: string, visible: boolean) => void;
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
   * calls are audited only after the user decides, before Mivlet dispatches the tool.
   */
  recordBackendToolCall: (event: {
    allowAutomatic?: boolean;
    callId: string;
    tool: string;
    arguments: string;
    approval: ApprovalRequest;
  }) => void;
  approvalPreviews: Record<string, { summary: string; details: string }>;
  /** Remove cancelled backend tool calls from the transient approval queue. */
  clearBackendToolApprovals: (ids?: readonly string[]) => void;
  /** Optional hosted identity, separate from local data and provider credentials. */
  identityStatus: IdentityStatus;
  identityPending: boolean;
  accountWorkspaceStatus: AccountWorkspaceStatus;
  runtimeSnapshotError: string | null;
  runtimeSnapshotReady: boolean;
  accountWorkspacePending: boolean;
  signInIdentity: (mode?: "sign-in" | "sign-up") => Promise<void>;
  recoverIdentity: () => Promise<void>;
  refreshIdentity: () => Promise<void>;
  signOutIdentity: () => Promise<void>;
  reconcileAccountWorkspace: () => Promise<void>;
  /**
   * Inspectable action history (model calls, connector actions, tool/shell
   * actions, web actions, approvals, and blocked policy decisions).
   * Audit observes actions and never carries secrets. Surfaced for the
   * Settings / Privacy / History view.
   */
  actionHistory: ActionHistoryEvent[];
  /** Re-fetch action history from the Rust store (poll on demand). */
  refreshActionHistory: () => void;
  // shell-level status
  lastAction: string;

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
  /** Interrupt the active provider when hydration discards its pending UI. */
  onScopeReset?: () => void;
}

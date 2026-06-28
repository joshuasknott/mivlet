export type PermissionMode = "read-only" | "trusted-scope" | "full-access";

export type ApprovalDecision = "once" | "session" | "rule" | "modify" | "deny";
export type ApprovalRiskLevel = "low" | "medium" | "high" | "critical";
export type ApprovalGrantScope = "session" | "rule";

export interface ApprovalRequest {
  id: string;
  service: string;
  action: string;
  mode: PermissionMode;
  riskLevel: ApprovalRiskLevel;
  dataUsed: string[];
  consequence: string;
  requestedAt: string;
  decisions: ApprovalDecision[];
  confirmationPhrase?: string;
}

export interface ApprovalModification {
  mode: PermissionMode;
  dataUsed: string[];
  consequence: string;
}

export interface ApprovalGrant {
  id: string;
  requestId: string;
  scope: ApprovalGrantScope;
  service: string;
  action: string;
  mode: PermissionMode;
  dataUsed: string[];
  createdAt: string;
}

export interface ApprovalResolutionRequest {
  request: ApprovalRequest;
  decision: ApprovalDecision;
  decidedAt: string;
  confirmationText?: string;
  modification?: ApprovalModification;
}

export interface ApprovalResolutionResponse {
  persisted: boolean;
  auditEntry: ApprovalAuditEntry;
  effectiveRequest: ApprovalRequest;
  dismissed: boolean;
  grant?: ApprovalGrant;
}

export type MemoryKind = "fact" | "inference" | "preference" | "imported";

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  title: string;
  value: string;
  source: string;
  freshness: string;
  approved: boolean;
  pinned: boolean;
}

export interface MemoryControlState {
  disabled: boolean;
  records: MemoryRecord[];
}

export interface MemoryPromotionRequest {
  source: KnowledgeSource;
  decision: ApprovalDecision;
  decidedAt: string;
  state: MemoryControlState;
}

export interface MemoryPromotionResponse {
  persisted: boolean;
  record: MemoryRecord;
  auditEntry: ApprovalAuditEntry;
  state: MemoryControlState;
}

export type FirstWaveConnectorId =
  | "github"
  | "vercel"
  | "google-drive"
  | "notion"
  | "gmail"
  | "slack"
  | "google-calendar"
  | "linear";

export type ConnectorId = "local-files" | FirstWaveConnectorId | (string & {});

export type ConnectorStatus =
  | "fixture"
  | "needs-auth"
  | "configured"
  | "connected"
  | "expired"
  | "error"
  | "unavailable";

export type ConnectorAuthMode =
  | "none"
  | "fixture"
  | "oauth-pkce"
  | "oauth-broker"
  | "provider-installation";

export type ConnectorPermissionAccess = "read" | "write";

export interface ConnectorPermission {
  id: string;
  label: string;
  access: ConnectorPermissionAccess;
  required: boolean;
  granted: boolean;
}

export type ConnectorHealthState = "healthy" | "degraded" | "error" | "unknown";

export interface ConnectorHealth {
  state: ConnectorHealthState;
  summary: string;
  checkedAt: string;
  retryAfter?: string;
}

export interface ConnectorAccountSummary {
  id: string;
  displayName: string;
  handle?: string;
  email?: string;
  workspace?: string;
  avatarUrl?: string;
}

export interface ConnectorManifest {
  id: ConnectorId;
  name: string;
  status: ConnectorStatus;
  permissions: string[];
  healthSummary: string;
  lastCheckedAt: string;
  authMode?: ConnectorAuthMode;
  scopes?: ConnectorPermission[];
  health?: ConnectorHealth;
  account?: ConnectorAccountSummary;
  setupMessage?: string;
  supportsSearch?: boolean;
  supportsImport?: boolean;
  supportedActions?: ConnectorActionKind[];
  /**
   * Optional backend facet. When present, this connector entry surfaces an
   * agent-runtime AI backend (Codex, Cursor, Copilot, Grok) whose auth state
   * and capabilities are owned by the Rust credential boundary. The frontend
   * only ever sees `authState` and `capabilities` — never raw tokens.
   */
  backend?: BackendProvider;
}

export type ConnectorItemKind =
  | "repository"
  | "branch"
  | "issue"
  | "pull-request"
  | "file"
  | "project"
  | "deployment"
  | "page"
  | "database"
  | "message"
  | "conversation"
  | "calendar"
  | "event";

export interface ConnectorSearchRequest {
  connectorId: FirstWaveConnectorId;
  query: string;
  limit?: number;
  cursor?: string;
}

export interface ConnectorSearchItem {
  id: string;
  connectorId: FirstWaveConnectorId;
  title: string;
  kind: ConnectorItemKind;
  summary: string;
  provenance: string;
  freshness: string;
  trust: KnowledgeTrust;
  url?: string;
  contentPreview?: string;
  providerMetadata: Record<string, string>;
}

export interface ConnectorSearchResult {
  connectorId: FirstWaveConnectorId;
  query: string;
  items: ConnectorSearchItem[];
  nextCursor?: string;
  source: "fixture" | "live";
  searchedAt: string;
}

export interface ConnectorImportRequest {
  connectorId: FirstWaveConnectorId;
  item: ConnectorSearchItem;
  importedAt: string;
}

export interface ConnectorImportResult {
  source: KnowledgeSource;
  imported: boolean;
}

export type ConnectorActionKind =
  | "github.draft-pull-request"
  | "github.comment"
  | "vercel.promote"
  | "vercel.rollback"
  | "github.create-issue"
  | "github.update-issue"
  | "github.create-review"
  | "github.update-file"
  | "github.create-branch"
  | "github.dispatch-workflow"
  | "vercel.create-deployment"
  | "vercel.cancel-deployment"
  | "vercel.update-project"
  | "vercel.create-domain"
  | "vercel.update-domain"
  | "vercel.delete-domain"
  | "linear.create-issue"
  | "linear.update-issue"
  | "linear.comment"
  | "google-drive.create-file"
  | "google-drive.update-file"
  | "google-drive.move-file"
  | "google-drive.rename-file"
  | "google-drive.share-file"
  | "google-drive.delete-file"
  | "gmail.create-draft"
  | "gmail.send"
  | "slack.create-draft"
  | "slack.post"
  | "slack.reply"
  | "slack.edit"
  | "slack.delete"
  | "slack.react-add"
  | "slack.react-remove"
  | "notion.create-page"
  | "notion.update-page"
  | "notion.append-blocks"
  | "notion.update-block"
  | "notion.delete-block"
  | "notion.create-comment"
  | "notion.create-entry"
  | "google-calendar.create-draft"
  | "google-calendar.update-draft"
  | "google-calendar.delete-event";

export interface ConnectorActionRequest {
  id: string;
  connectorId: FirstWaveConnectorId;
  action: ConnectorActionKind;
  payload: Record<string, string>;
  approval: ApprovalRequest;
}

export type ConnectorActionResultStatus =
  | "awaiting-approval"
  | "executed"
  | "denied"
  | "configuration-required";

export interface ConnectorActionResult {
  requestId: string;
  connectorId: FirstWaveConnectorId;
  action: ConnectorActionKind;
  status: ConnectorActionResultStatus;
  message: string;
  providerResourceId?: string;
}

export type ConnectorErrorCode =
  | "configuration-required"
  | "needs-auth"
  | "expired-auth"
  | "permission-denied"
  | "rate-limited"
  | "provider-unavailable"
  | "not-found"
  | "invalid-request"
  | "approval-required"
  | "unknown";

export interface ConnectorError {
  code: ConnectorErrorCode;
  connectorId: ConnectorId;
  message: string;
  retryable: boolean;
  retryAfter?: string;
}

export interface ConnectorAuthRequest {
  connectorId: FirstWaveConnectorId;
  redirectUri?: string;
  /** Authorization callback URL, or the provider-returned code when completing OAuth. */
  callbackUrl?: string;
  /** Optional incremental subset of the connector's declared OAuth scopes. */
  requestedScopes?: string[];
}

export interface ConnectorAuthResult {
  connectorId: FirstWaveConnectorId;
  status: ConnectorStatus;
  authorizationUrl?: string;
  account?: ConnectorAccountSummary;
  message: string;
}

export interface ConnectorTokenSet {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt?: string;
  scopes: string[];
}

export type ConnectorCapabilityKind = "read" | "write";

export interface ConnectorCapability {
  id: string;
  kind: ConnectorCapabilityKind;
  consequential: boolean;
  description: string;
}

export interface ConnectorPage<T> {
  items: T[];
  nextCursor?: string;
  rateLimit?: {
    remaining?: number;
    resetAt?: string;
    retryAfterMs?: number;
  };
}

export interface ConnectorApprovalRecord {
  id: string;
  connectorId: ConnectorId;
  accountId: string;
  proposedAction: string;
  target: string;
  preview: string;
  riskLevel: ApprovalRiskLevel;
  result: "pending" | "approved" | "denied" | "executed" | "failed";
  requestId: string;
  requestedAt: string;
  decidedAt?: string;
  executedAt?: string;
  actor: "user" | "system";
  runId?: string;
  errorCode?: ConnectorErrorCode;
  actionFingerprint?: string;
}

export type AgentRunStatus =
  | "queued"
  | "streaming"
  | "awaiting-approval"
  | "retrying"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";

export interface PersistedAgentRun {
  id: string;
  providerId: string;
  model: string;
  status: AgentRunStatus;
  transcript: string;
  turn: number;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
  pendingApprovalIds: string[];
  recoverable: boolean;
  retryCount: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The transport a backend speaks. Codex reaches its app-server, Cursor and
 * Grok share a generic ACP (stdio/JSON-RPC) adapter, Copilot uses its SDK, and
 * the native-API providers (OpenAI, Anthropic, Gemini, xAI, OpenRouter) speak
 * their HTTP/SSE APIs directly — with Fable owning the entire agent loop.
 */
export type BackendType = "codex-app-server" | "acp" | "copilot-sdk" | "native-api";

/**
 * Resolved auth state for a backend instance. `install-required` and
 * `entitlement-pending` are fail-closed states: the adapter declares no
 * capabilities it cannot honor.
 */
export type BackendAuthState =
  | "connected"
  | "needs-auth"
  | "install-required"
  | "entitlement-pending"
  | "unavailable";

/**
 * The closed capability set an adapter may declare dynamically. The UI may
 * only render a control for a capability the adapter actually reported.
 */
export type BackendCapability =
  | "authentication"
  | "threads"
  | "streaming"
  | "tool-requests"
  | "approvals"
  | "file-changes"
  | "usage-cost"
  | "model-availability"
  | "cancellation";

/** A selectable model exposed by a backend. */
export interface BackendModel {
  id: string;
  label: string;
  available: boolean;
}

/**
 * Describes a connected (or connectable) agent-runtime backend. Capabilities
 * and entitlements are resolved dynamically from the current auth state —
 * adapters must never fake a capability they lack.
 */
export interface BackendProvider {
  id: string;
  backendType: BackendType;
  label: string;
  description: string;
  authState: BackendAuthState;
  capabilities: BackendCapability[];
  models: BackendModel[];
  /** Shown when `authState === "install-required"` (e.g. a missing CLI). */
  installHint?: string;
  /**
   * Entitlements detected post-login only. Grok Build is never promised for any
   * tier in fixture/preview data — it only appears here after a real check.
   */
  entitlements?: string[];
}

/**
 * Request to store a backend credential. The secret is handed to the Rust
 * credential boundary and never read back into JavaScript.
 */
export interface BackendCredentialRequest {
  providerId: string;
  secret: string;
}

/**
 * A consequential action a backend wants to perform (tool call, file write,
 * shell command). Fable routes these into its existing ApprovalRequest system
 * rather than letting the backend execute them directly.
 */
export interface BackendConsequentialEvent {
  providerId: string;
  service: string;
  action: string;
  mode: PermissionMode;
  riskLevel: ApprovalRiskLevel;
  dataUsed: string[];
  consequence: string;
  /** When the backend already approved this internally, record it as audit. */
  backendPreapproved?: boolean;
}

/** An audit entry recording a backend-originated action. */
export interface BackendEventAudit {
  providerId: string;
  auditEntry: ApprovalAuditEntry;
}

export interface WorkspaceDirective {
  id: string;
  label: string;
  source: string;
  prompt: string;
  connectorIds: string[];
}

export interface ThreadSummary {
  id: string;
  title: string;
  kind: "chat" | "project";
  description: string;
  updatedAt: string;
  pinnedContextIds: string[];
}

export interface ProjectWorkspace {
  id: string;
  title: string;
  description: string;
  threads: ThreadSummary[];
}

export type KnowledgeSourceKind = "document" | "folder" | "web" | "memory";
export type KnowledgeTrust = "trusted" | "untrusted";

export interface KnowledgeSource {
  id: string;
  title: string;
  kind: KnowledgeSourceKind;
  connectorId: string;
  provenance: string;
  freshness: string;
  pinned: boolean;
  trust?: KnowledgeTrust;
  contentPreview?: string;
  contentFingerprint?: string;
  sizeBytes?: number;
  importedAt?: string;
  origin?: "fixture" | "local-import" | "connector-import";
  providerMetadata?: Record<string, string>;
}

export interface LocalFileImport extends KnowledgeSource {
  kind: "document";
  connectorId: "local-files";
  trust: "untrusted";
  contentPreview: string;
  contentFingerprint: string;
  sizeBytes: number;
  importedAt: string;
  origin: "local-import";
}

export interface KnowledgeCitation {
  sourceId: string;
  title: string;
  snippet: string;
  provenance: string;
  freshness: string;
  trust: KnowledgeTrust;
  pinned: boolean;
  score: number;
}

export interface KnowledgeSearchResponse {
  query: string;
  mode: "lexical-fallback" | "hybrid";
  citations: KnowledgeCitation[];
}

export type AutomationStatus = "draft" | "active" | "paused";

export interface AutomationRule {
  id: string;
  title: string;
  trigger: string;
  destination: string;
  status: AutomationStatus;
  requiresApproval: boolean;
}

/**
 * A weekday a user-created schedule may fire on. Kept in the shared protocol so
 * the shell, the runtime snapshot contract, and the Rust normalization layer
 * all reference one closed vocabulary.
 */
export type ScheduleWeekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

/**
 * A user-created schedule carried in the runtime snapshot. Non-secret: only the
 * task name/description, when it fires, and bookkeeping. Execution is still
 * linked up at runtime so a connected model can pick it up; nothing auto-runs.
 */
export interface ScheduleEntry {
  id: string;
  name: string;
  description: string;
  day: ScheduleWeekday;
  /** "HH:MM", 24-hour. */
  time: string;
  enabled: boolean;
  /** ISO timestamp. */
  createdAt: string;
}

export interface ApprovalAuditEntry {
  id: string;
  requestId: string;
  decision: ApprovalDecision;
  decidedAt: string;
  note: string;
}

export interface RuntimeSnapshot {
  version: 1;
  activeItem: string;
  composerDraft: string;
  voiceEnabled: boolean;
  approvalAudit: ApprovalAuditEntry[];
  dismissedApprovalIds: string[];
  approvalRules: ApprovalGrant[];
  automationStatuses: Record<string, AutomationStatus>;
  /**
   * User-created schedules. Non-secret state persisted through the snapshot so
   * it survives a desktop restart (the snapshot is the source of truth for
   * non-secret state in Tauri). LocalStorage carries them in preview only.
   */
  schedules: ScheduleEntry[];
  pinnedSourceIds: string[];
  importedKnowledgeSources: LocalFileImport[];
  memoryDisabled: boolean;
  memoryRecords: MemoryRecord[];
  /**
   * Provider ids of connected agent-runtime backends. Credentials themselves
   * never live here — this only records *which* backends were connected so the
   * Rust boundary can re-resolve their auth state on recovery.
   */
  connectedBackendIds: string[];
  /**
   * The model id last chosen in the composer's model picker, so the same model
   * drives the next agent run. Re-validated against the connected backend's
   * available models before use (empty string = let Fable pick).
   */
  selectedModelId: string;
  /**
   * The composer's permission level, driving how the agent loop gates tool
   * approvals (read-only suppresses write/shell tool calls, etc.).
   */
  permissionMode: PermissionMode;
  savedAt: string;
}

// ---------------------------------------------------------------------------
// Scheduler, workflows, notifications, voice (local automation engine).
//
// These are wire types only. Pure logic lives in @fable/connectors; durable
// storage + OS integration lives in the Rust boundary; the shell wires them.
// ---------------------------------------------------------------------------

/** One-time or recurring trigger for a scheduled job. */
export type ScheduleTriggerKind = "once" | "recurring";

/** How to handle a run that was missed while the runtime was inactive. */
export type MissedRunPolicy =
  | "skip" // drop missed occurrences (default)
  | "run-once" // run the most recent missed occurrence once
  | "run-all"; // run every missed occurrence in order

/** Daily/weekly/monthly recurrence. Deliberately small (RRULE-lite). */
export interface RecurrenceRule {
  frequency: "daily" | "weekly" | "monthly";
  /** 1 = every interval; 2 = every other, etc. */
  interval: number;
  /** Weekdays (Mon..Sun) for weekly frequency. Empty/omitted = every day. */
  byWeekday?: ScheduleWeekday[];
  /** Day-of-month (1..31) for monthly frequency. */
  byMonthDay?: number;
  /** 24-hour local hour 0..23. */
  hour: number;
  /** Minute 0..59. */
  minute: number;
  /** Inclusive ISO timestamp; no occurrence fires after this. */
  until?: string;
  /** IANA timezone id, e.g. "America/New_York". DST-aware. */
  timezone?: string;
}

export type ScheduleTrigger =
  | {
      kind: "once";
      /** ISO timestamp of the single occurrence. */
      at: string;
    }
  | {
      kind: "recurring";
      rule: RecurrenceRule;
    };

/** Status of a durable scheduled job (definition + lifecycle). */
export type ScheduledJobStatus = "active" | "paused" | "deleted";

/**
 * A durable scheduled job. Supersedes the bare ScheduleEntry for execution.
 * ScheduleEntry remains for the legacy snapshot; this is the engine's record.
 */
export interface ScheduledJob {
  /** Stable id. */
  id: string;
  /** Schema version of this job record. */
  schemaVersion: number;
  name: string;
  description: string;
  /** The workflow definition id this job runs. */
  workflowDefinitionId: string;
  trigger: ScheduleTrigger;
  missedRunPolicy: MissedRunPolicy;
  status: ScheduledJobStatus;
  /** ISO timestamp of the next calculated occurrence (empty when paused/none). */
  nextRunAt: string;
  /** ISO timestamp of the last completed run (empty when never run). */
  lastRunAt: string;
  /** Id of the last workflow run, for "last result" display. */
  lastRunId: string;
  createdAt: string;
  updatedAt: string;
}

/** Attempt outcome for a single job execution attempt. */
export type JobAttemptStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface JobAttempt {
  /** Id of the workflow run this attempt produced. */
  runId: string;
  status: JobAttemptStatus;
  attemptNumber: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export type SchedulerJobState = "queued" | "leased" | "done" | "dead";

/** A queued execution entry in the durable scheduler queue. */
export interface SchedulerQueueEntry {
  /** Job id this entry is for. */
  jobId: string;
  /** Workflow run id to create/use. */
  runId: string;
  /** Scheduled fire time (ISO). */
  scheduledAt: string;
  /** Current queue state. */
  state: SchedulerJobState;
  /** Opaque lease holder id (window/instance id). Empty when unleased. */
  leaseHolder: string;
  /** ISO timestamp the lease expires (empty when unleased). */
  leaseExpiresAt: string;
  /** Attempt history (newest last). */
  attempts: JobAttempt[];
  /** Idempotency key deduplicating this scheduled occurrence. */
  deduplicationKey: string;
}

// ---------------------------------------------------------------------------
// Workflow definitions + runs.
// ---------------------------------------------------------------------------

export type WorkflowStepKind =
  | "prompt" // run an agent turn with a prompt
  | "connector-read" // read from a connector capability
  | "agent" // multi-turn agent step (tool calls gated)
  | "tool" // a single Fable-owned tool call
  | "approval"; // pause for fresh explicit approval

export interface WorkflowPromptStep {
  kind: "prompt";
  id: string;
  prompt: string;
  /** Connector ids this step depends on (for honest degradation). */
  requiresConnectors?: string[];
}

export interface WorkflowConnectorReadStep {
  kind: "connector-read";
  id: string;
  connectorId: string;
  capability: string;
  input: Record<string, unknown>;
  /** Output variable name to store the read result. */
  outputVar: string;
}

export interface WorkflowAgentStep {
  kind: "agent";
  id: string;
  prompt: string;
  /** Max agent turns for this step. */
  maxTurns?: number;
  requiresConnectors?: string[];
}

export interface WorkflowToolStep {
  kind: "tool";
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  /** True for consequential writes (forces approval pause). */
  consequential: boolean;
}

export interface WorkflowApprovalStep {
  kind: "approval";
  id: string;
  /** Human description of what is being approved. */
  description: string;
}

export type WorkflowStep =
  | WorkflowPromptStep
  | WorkflowConnectorReadStep
  | WorkflowAgentStep
  | WorkflowToolStep
  | WorkflowApprovalStep;

/**
 * A versioned, editable workflow definition. Editing creates a new version so
 * historical runs keep the definition they executed against.
 */
export interface WorkflowDefinition {
  /** Schema version of the definition shape. */
  schemaVersion: number;
  id: string;
  /** Monotonic version; edits bump this and keep history immutable. */
  version: number;
  name: string;
  description: string;
  steps: WorkflowStep[];
  /** Per-workflow notification preferences. */
  notificationPrefs?: NotificationPrefs;
  createdAt: string;
  updatedAt: string;
}

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowStepRecordStatus =
  | "pending"
  | "running"
  | "awaiting-approval"
  | "succeeded"
  | "failed"
  | "skipped";

export interface WorkflowStepRecord {
  stepId: string;
  status: WorkflowStepRecordStatus;
  /** Stored inputs/outputs for transparency. */
  input?: unknown;
  output?: unknown;
  /** Tool calls made during this step (transparent history). */
  toolCalls?: { tool: string; arguments: string; ok: boolean; output: string }[];
  /** Approval state for approval/tool steps. */
  approval?: {
    decision: "pending" | "approved" | "denied" | "expired";
    decidedAt?: string;
    expiresAt?: string;
  };
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

/** What triggered a workflow run. */
export type WorkflowRunTrigger = "schedule" | "manual" | "voice";

export interface WorkflowRun {
  id: string;
  /** The definition this run executes. */
  definitionId: string;
  /** Snapshot version of the definition at run time (immutable history). */
  definitionVersion: number;
  status: WorkflowRunStatus;
  trigger: WorkflowRunTrigger;
  /** Job id when trigger === "schedule". */
  scheduledJobId?: string;
  /** Inputs supplied to the run. */
  input: Record<string, unknown>;
  /** Per-step records, in execution order. */
  steps: WorkflowStepRecord[];
  /** Failure reason when status === "failed". */
  failureReason?: string;
  /** Idempotency key for external mutations. */
  idempotencyKey?: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}

// ---------------------------------------------------------------------------
// Notifications.
// ---------------------------------------------------------------------------

export type NotificationKind = "run-completed" | "run-failed" | "approval-needed";

export interface NotificationRecord {
  id: string;
  kind: NotificationKind;
  /** Workflow run id the notification refers to. */
  runId: string;
  /** Workflow definition id (for per-workflow prefs). */
  definitionId?: string;
  title: string;
  /** Public body (no private content). Always safe to show in OS UI. */
  body: string;
  /** Whether the OS notification was suppressed (per prefs / disabled). */
  suppressed: boolean;
  createdAt: string;
  /** Deep-link target (page + run id) for click navigation. */
  deepLink?: { page: string; runId: string };
  /** True once delivered to the OS notification center. */
  delivered: boolean;
}

export interface NotificationPrefs {
  /** Disable OS notifications for this workflow (in-app history still kept). */
  disableOs: boolean;
  /** Kinds to surface. */
  enabledKinds: NotificationKind[];
}

// ---------------------------------------------------------------------------
// Voice (pluggable STT boundary).
// ---------------------------------------------------------------------------

export type VoiceProviderKind = "local" | "remote";

export interface VoiceProviderDescriptor {
  id: string;
  kind: VoiceProviderKind;
  label: string;
  /** Whether raw audio is retained (must be false for the default local path). */
  retainsAudio: boolean;
  /** Setup/install message when the provider is unavailable. */
  setupHint?: string;
}

/** Discrete recording state for push-to-talk. */
export type VoiceRecordingState = "idle" | "recording" | "processing" | "review" | "error";

// ---------------------------------------------------------------------------
// Native-API agent loop: events + request shaping.
//
// The TypeScript layer owns request/response shaping + the agent loop as pure,
// fixture-testable logic; the Rust boundary owns the API key + HTTP/SSE egress.
// The API key NEVER appears in any of these types — it is added as an
// Authorization/x-api-key/x-goog-api-key header inside Rust only.
// ---------------------------------------------------------------------------

/** A message role in the normalized conversation. */
export type NativeMessageRole = "system" | "user" | "assistant" | "tool";

/** A single conversation message. `toolCallId` pairs a tool result to its call. */
export interface NativeMessage {
  role: NativeMessageRole;
  content: string;
  /** Assistant tool calls, when role === "assistant" and the model requested tools. */
  toolCalls?: NativeToolCall[];
  /** Tool-result call id, when role === "tool". */
  toolCallId?: string;
  /** Tool name for providers (for example Gemini) that require it on results. */
  toolName?: string;
}

/** A tool call the model emitted. The arguments are the raw model JSON string. */
export interface NativeToolCall {
  callId: string;
  tool: string;
  arguments: string;
}

/** A tool the loop advertises to the model (Fable-owned, from the registry). */
export interface NativeToolSpec {
  name: string;
  description: string;
  /** JSON-schema parameter shape, serialized as a string for transport. */
  parameters: string;
}

/** An Fable-owned tool the native loop may dispatch after approval. */
export interface BackendTool {
  name: string;
  description: string;
  defaultMode: PermissionMode;
  defaultRisk: ApprovalRiskLevel;
  parameters: string;
}

/** Normalized completion request the loop shapes per provider. No key, no URL. */
export interface NativeCompletionRequest {
  providerId: string;
  model: string;
  messages: NativeMessage[];
  tools: NativeToolSpec[];
  /** Max output tokens; provider shapers clamp to the provider's limit. */
  maxTokens: number;
}

/**
 * A normalized agent-loop event streamed back to the shell — the shared event
 * surface for the native-API loop. Model tool calls arrive as `tool-call`
 * carrying a pre-shaped ApprovalRequest so they route through Fable's existing
 * approval queue before the tool is executed.
 */
export type BackendAgentEvent =
  | { type: "text-delta"; text: string }
  | {
      type: "tool-call";
      callId: string;
      tool: string;
      arguments: string;
      approval: ApprovalRequest;
    }
  | { type: "tool-result"; callId: string; ok: boolean; output: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: "done"; finishReason: "stop" | "tool-calls" | "length" | "error" }
  | { type: "error"; message: string }
  | { type: "cancelled" };

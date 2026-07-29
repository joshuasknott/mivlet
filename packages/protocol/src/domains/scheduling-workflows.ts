import type { ConnectorId } from "./connectors.js";
import type {
  ApprovalRiskLevel,
  PermissionMode,
  PermissionProfileId
} from "./approvals.js";
import type { ProviderRouteExecutionBinding } from "./agent-runtime.js";

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
 * The frozen, non-secret execution route captured when a schedule is created.
 *
 * A schedule pins which backend/model/permission runs it so scheduled work
 * never silently switches provider, model, or permission mode. At create time,
 * if a backend is connected the route is `pinned` to the current backend/model;
 * otherwise it is `current-default` and resolved against whatever is connected
 * at execution time.
 *
 * SECRET INVARIANT: this carries only provider/model ids + permission mode —
 * never keys, tokens, or credentials.
 */
export interface ScheduledExecutionRoute {
  policy: "pinned" | "current-default";
  backendId: string;
  modelId: string;
  permissionMode: PermissionMode;
  permissionProfile?: PermissionProfileId;
}

/** Bounded retry policy captured with a scheduled occurrence. */
export interface RetryPolicy {
  /** Total attempts, including the initial attempt. */
  maxAttempts: number;
  /** Delay before the first retry. */
  initialBackoffMs: number;
  /** Multiplier applied after each failed attempt. */
  backoffMultiplier: number;
  /** Upper bound for any individual retry delay. */
  maxBackoffMs: number;
}

/**
 * A durable scheduled job. Supersedes the bare ScheduleEntry for execution.
 * ScheduleEntry remains for the legacy snapshot; this is the engine's record.
 */
export interface ScheduledJob {
  /** Durable local workspace scope. */
  workspaceId?: string;
  /** Optional project owner; absent means the record belongs to the workspace. */
  projectId?: string;
  /** Native-only migration provenance; renderer input is never authoritative. */
  authority?: "local";
  visibility?: "member-private";
  ownerMemberId?: string;
  createdByInternalUserId?: string;
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
  /** Frozen execution route (backend/model/permission). Resolved at run time. */
  execution?: ScheduledExecutionRoute;
  /** Retry policy snapshotted onto each occurrence when it is queued. */
  retryPolicy?: RetryPolicy;
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
export type JobAttemptStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "blocked-auth";

export interface JobAttempt {
  /** Id of the workflow run this attempt produced. */
  runId: string;
  status: JobAttemptStatus;
  attemptNumber: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** Whether a failed attempt should be retried (transient) or not (permanent). */
  retryable?: boolean;
  /** Fencing token proving this attempt corresponds to the current lease. */
  leaseToken?: string;
}

/**
 * The full lifecycle vocabulary of a scheduler queue entry. The Rust store is
 * the authority; this mirrors its states so the shell can render them truthfully.
 */
export type SchedulerJobState =
  | "queued"
  | "leased"
  | "running"
  | "completed"
  | "failed"
  | "blocked-auth"
  | "cancelled"
  | "done"
  | "dead";

export type SchedulerJobStateLegacy = "queued" | "leased" | "done" | "dead";

/** A queued execution entry in the durable scheduler queue. */
export interface SchedulerQueueEntry {
  workspaceId?: string;
  projectId?: string;
  /** Native-only migration provenance; absent on unresolved legacy entries. */
  authority?: "local";
  visibility?: "member-private";
  ownerMemberId?: string;
  createdByInternalUserId?: string;
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
  /** Fencing token proving a report/renew call corresponds to the current lease. */
  leaseToken?: string;
  /** Earliest retry time (ISO) after a transient failure; honored by the tick. */
  availableAt?: string;
  /** Last error message (truncated, no secrets) for failed/blocked entries. */
  lastError?: string;
  /** Frozen retry policy for this occurrence. */
  retryPolicy?: RetryPolicy;
}

// ---------------------------------------------------------------------------
// Workflow definitions + runs.
// ---------------------------------------------------------------------------

export type WorkflowStepKind =
  | "prompt" // run an agent turn with a prompt
  | "connector-read" // read from a connector capability
  | "connector-write" // write through ConnectorRuntime + fresh approval
  | "agent" // multi-turn agent step (tool calls gated)
  | "tool" // a single Fable-owned tool call
  | "approval"; // pause for fresh explicit approval

export interface WorkflowPromptStep {
  kind: "prompt";
  id: string;
  prompt: string;
  /** Connector ids this step depends on (for honest degradation). */
  requiresConnectors?: string[];
  /** Optional task-level override, revalidated immediately before execution. */
  permissionProfile?: PermissionProfileId;
}

export interface WorkflowConnectorReadStep {
  kind: "connector-read";
  id: string;
  connectorId: string;
  capability: string;
  input: Record<string, unknown>;
  /** Output variable name to store the read result. */
  outputVar: string;
  /** Optional task-level override, revalidated immediately before execution. */
  permissionProfile?: PermissionProfileId;
}

export interface WorkflowConnectorWriteStep {
  kind: "connector-write";
  id: string;
  connectorId: string;
  capability: string;
  input: Record<string, unknown>;
  target: string;
  preview: string;
  riskLevel: ApprovalRiskLevel;
  outputVar?: string;
  permissionProfile?: PermissionProfileId;
}

export interface WorkflowAgentStep {
  kind: "agent";
  id: string;
  prompt: string;
  /** Max agent turns for this step. */
  maxTurns?: number;
  requiresConnectors?: string[];
  /** Optional task-level override, revalidated immediately before execution. */
  permissionProfile?: PermissionProfileId;
}

export interface WorkflowToolStep {
  kind: "tool";
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  /** True for consequential writes (forces approval pause). */
  consequential: boolean;
  /** Optional task-level override, revalidated immediately before execution. */
  permissionProfile?: PermissionProfileId;
}

export interface WorkflowApprovalStep {
  kind: "approval";
  id: string;
  /** Human description of what is being approved. */
  description: string;
  permissionProfile?: PermissionProfileId;
}

export type WorkflowStep =
  | WorkflowPromptStep
  | WorkflowConnectorReadStep
  | WorkflowConnectorWriteStep
  | WorkflowAgentStep
  | WorkflowToolStep
  | WorkflowApprovalStep;

/**
 * A versioned, editable workflow definition. Editing creates a new version so
 * historical runs keep the definition they executed against.
 */
export interface WorkflowDefinition {
  /** Native-only migration provenance; renderer input is never authoritative. */
  workspaceId?: string;
  projectId?: string;
  authority?: "local";
  visibility?: "member-private";
  ownerMemberId?: string;
  createdByInternalUserId?: string;
  /** Schema version of the definition shape. */
  schemaVersion: number;
  id: string;
  /** Monotonic version; edits bump this and keep history immutable. */
  version: number;
  name: string;
  description: string;
  /** A paused definition cannot start new runs; existing history remains readable. */
  status?: "active" | "paused";
  /** Default permission profile for every task and run. */
  permissionProfile?: PermissionProfileId;
  steps: WorkflowStep[];
  /** Per-workflow notification preferences. */
  notificationPrefs?: NotificationPrefs;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Departments: narrow user-facing workflow lanes.
// ---------------------------------------------------------------------------

export type DepartmentId = "research" | "ship" | (string & {});
export type PipelineId = string & {};
export type ConnectorNeedAccess = "read" | "write";
export type ApprovalRequirementKind = "none" | "fresh-explicit" | "high-risk";

export interface ConnectorNeed {
  connectorId: ConnectorId;
  access: ConnectorNeedAccess;
  reason: string;
  optional?: boolean;
}

export interface ScheduleTriggerNeed {
  kind: "manual" | "scheduled";
  description: string;
}

export interface ApprovalRequirement {
  kind: ApprovalRequirementKind;
  reason: string;
}

export interface RuntimeRoute {
  kind: "agent-backend";
  policy: ScheduledExecutionRoute["policy"];
  permissionMode: PermissionMode;
}

export interface PipelineStep {
  id: string;
  title: string;
  description: string;
  workflowStepId: string;
}

export interface Pipeline {
  id: PipelineId;
  departmentId: DepartmentId;
  name: string;
  description: string;
  steps: PipelineStep[];
  connectorNeeds: ConnectorNeed[];
  scheduleTrigger: ScheduleTriggerNeed;
  approvalRequirement: ApprovalRequirement;
  runtimeRoute: RuntimeRoute;
  workflow: WorkflowDefinition;
}

export interface Department {
  id: DepartmentId;
  name: string;
  summary: string;
  pipelines: Pipeline[];
}

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "completed"
  | "failed"
  | "blocked-auth"
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
  /** Stable machine-readable failure classification. */
  errorCode?: string;
}

/** What triggered a workflow run. */
export type WorkflowRunTrigger = "schedule" | "manual" | "voice";

export interface WorkflowRun {
  /** Native-only migration provenance; renderer input is never authoritative. */
  workspaceId?: string;
  projectId?: string;
  authority?: "local";
  visibility?: "member-private";
  ownerMemberId?: string;
  createdByInternalUserId?: string;
  id: string;
  /** The definition this run executes. */
  definitionId: string;
  /** Snapshot version of the definition at run time (immutable history). */
  definitionVersion: number;
  status: WorkflowRunStatus;
  trigger: WorkflowRunTrigger;
  /** Job id when trigger === "schedule". */
  scheduledJobId?: string;
  /** Permission profile captured when the run starts. */
  permissionProfile?: PermissionProfileId;
  /** Exact native provider route retained after a routed scheduled execution. */
  providerRoute?: ProviderRouteExecutionBinding;
  /** Inputs supplied to the run. */
  input: Record<string, unknown>;
  /** Per-step records, in execution order. */
  steps: WorkflowStepRecord[];
  /** Failure reason when status === "failed". */
  failureReason?: string;
  /** Idempotency key for external mutations. */
  idempotencyKey?: string;
  /** Scheduler attempt number represented by this run snapshot. */
  attemptNumber?: number;
  /** Earliest time the scheduler may retry this run. */
  nextRetryAt?: string;
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
  /** Whether Fable retains raw audio. This does not describe a platform vendor's policy. */
  retainsAudio: boolean;
  /** Setup/install message when the provider is unavailable. */
  setupHint?: string;
}

/** Side-effect-free availability check. Detecting support must never request microphone access. */
export type VoiceCapability =
  | { status: "supported"; provider: VoiceProviderDescriptor }
  | { status: "unavailable"; provider: VoiceProviderDescriptor; reason: string };

export type VoiceFailureCode =
  | "cancelled"
  | "empty-result"
  | "permission-denied"
  | "runtime-failure"
  | "startup-failure"
  | "unavailable"
  | "unsupported";

/**
 * Dictation state shared by the orchestration hook and composer. `listening`
 * begins only after the platform confirms start; `success` means recognized
 * text was added to the ordinary composer draft, never submitted automatically.
 */
export type VoiceInputStatus =
  | "cancelled"
  | "disabled"
  | "error"
  | "idle"
  | "listening"
  | "permission-denied"
  | "processing"
  | "starting"
  | "stopping"
  | "success"
  | "unavailable"
  | "unsupported";

export interface VoiceInputState {
  status: VoiceInputStatus;
  message: string;
  errorCode: VoiceFailureCode | null;
}

/** @deprecated Use `VoiceInputState` for explicit capability and lifecycle behavior. */
export type VoiceRecordingState = VoiceInputState["status"];

/**
 * Portable contracts for durable artifacts and contextual routines.
 *
 * These records describe product intent, history, and authority boundaries.
 * Execution drivers own queues, leases, permits, and retry mechanics; those
 * runtime details intentionally do not appear in this module.
 */

import type {
  ArtifactId,
  ArtifactVersionId,
  CapabilityGrantId,
  ConnectionId,
  DepartmentId,
  ExecutionNodeId,
  GoalId,
  HandoffId,
  InternalUserId,
  IsoDateTime,
  MemberId,
  MissionId,
  PipelineId,
  ProjectId,
  ProviderRouteId,
  RecordMetadata,
  RecordScope,
  RoutineId,
  RunId,
  ThreadId,
  TriggerId,
  WorkspaceId
} from "./primitives.js";

export const ARTIFACT_KINDS = [
  "document",
  "report",
  "decision",
  "code-change",
  "design",
  "image",
  "video",
  "dataset",
  "configuration",
  "archive",
  "other"
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ARTIFACT_STATUSES = [
  "draft",
  "in-review",
  "changes-requested",
  "accepted",
  "published",
  "archived",
  "deleted"
] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export const ARTIFACT_VERSION_STATUSES = ["available", "redacted", "deleted"] as const;
export type ArtifactVersionStatus = (typeof ARTIFACT_VERSION_STATUSES)[number];

export const ARTIFACT_REVIEW_STATUSES = [
  "requested",
  "in-review",
  "approved",
  "changes-requested",
  "rejected",
  "withdrawn"
] as const;
export type ArtifactReviewStatus = (typeof ARTIFACT_REVIEW_STATUSES)[number];

export const ARTIFACT_RETENTION_STATUSES = [
  "active",
  "retention-hold",
  "export-requested",
  "export-ready",
  "deletion-requested",
  "deleted"
] as const;
export type ArtifactRetentionStatus = (typeof ARTIFACT_RETENTION_STATUSES)[number];

export const HANDOFF_STATUSES = ["proposed", "accepted", "rejected", "cancelled"] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export const ROUTINE_STATUSES = ["draft", "active", "paused", "retired", "deleted"] as const;
export type RoutineStatus = (typeof ROUTINE_STATUSES)[number];

export const TRIGGER_STATUSES = ["active", "paused", "retired", "deleted"] as const;
export type TriggerStatus = (typeof TRIGGER_STATUSES)[number];

export const ROUTINE_TRIGGER_KINDS = [
  "time-once",
  "time-recurring",
  "webhook",
  "connection-event",
  "threshold",
  "monitoring",
  "follow-up"
] as const;
export type RoutineTriggerKind = (typeof ROUTINE_TRIGGER_KINDS)[number];

export const MISSED_RUN_POLICIES = ["skip", "run-once", "run-all"] as const;
export type MissedRunPolicy = (typeof MISSED_RUN_POLICIES)[number];

export const ROUTINE_OCCURRENCE_STATUSES = [
  "recorded",
  "started",
  "awaiting-approval",
  "completed",
  "failed",
  "cancelled",
  "skipped",
  "blocked"
] as const;
export type RoutineOccurrenceStatus = (typeof ROUTINE_OCCURRENCE_STATUSES)[number];

export const LEGACY_SOURCE_KINDS = [
  "automation-rule",
  "schedule-entry",
  "schedule",
  "scheduled-job",
  "workflow-definition",
  "workflow-run",
  "scheduler-queue-entry",
  "legacy-artifact"
] as const;
export type LegacySourceKind = (typeof LEGACY_SOURCE_KINDS)[number];

/** Inline artifact text must be bounded by adapters before it enters this wire form. */
export const ARTIFACT_MAX_INLINE_CONTENT_BYTES = 65_536;

export interface ContentHash {
  algorithm: "sha-256" | "sha-384" | "sha-512" | (string & {});
  value: string;
}

export interface ArtifactMediaMetadata {
  mediaType: string;
  byteLength: number;
  fileName?: string;
  encoding?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  pageCount?: number;
}

/** A portable pointer; it is never a credential, local path, or authority grant. */
export interface ArtifactContentLocator {
  locator: string;
  media: ArtifactMediaMetadata;
  contentHash: ContentHash;
}

export type ArtifactContent =
  | {
      kind: "inline";
      /** UTF-8 text, bounded by ARTIFACT_MAX_INLINE_CONTENT_BYTES. */
      text: string;
      media: ArtifactMediaMetadata;
      contentHash: ContentHash;
    }
  | ({ kind: "locator" } & ArtifactContentLocator);

export interface LegacySourceProvenance {
  kind: LegacySourceKind;
  legacyId: string;
  legacySchemaVersion?: number;
  importedAt: IsoDateTime;
  /** Original fields retained only where they are portable and safe to expose. */
  retainedFields?: Readonly<Record<string, unknown>>;
}

export interface ArtifactSourceProvenance {
  kind: "run" | "import" | "user" | "connection" | "artifact-version" | "legacy";
  runId?: RunId;
  connectionId?: ConnectionId;
  sourceArtifactVersionId?: ArtifactVersionId;
  externalReference?: string;
  legacy?: LegacySourceProvenance;
  observedAt: IsoDateTime;
}

export interface ArtifactCitation {
  id: string;
  label: string;
  source: ArtifactSourceProvenance;
  locator?: string;
  quotedText?: string;
  contentHash?: ContentHash;
}

export interface ArtifactLineageLink {
  relation: "derived-from" | "supersedes" | "merged-from" | "references" | "exported-from";
  artifactId: ArtifactId;
  artifactVersionId?: ArtifactVersionId;
  recordedAt: IsoDateTime;
}

/** A durable input reference, never hidden conversation history or an authority grant. */
export interface ArtifactInputReference {
  kind: "user-input" | "source" | "artifact-version" | "connection-record";
  referenceId: string;
  label: string;
  recordedAt: IsoDateTime;
  contentHash?: ContentHash;
}

/** A compact factual decision record. Hidden reasoning is intentionally excluded. */
export interface ArtifactDecisionReference {
  id: string;
  kind: "user" | "approval" | "review" | "policy";
  summary: string;
  decidedAt: IsoDateTime;
  decidedByInternalUserId?: InternalUserId;
  approvalId?: string;
}

export interface ExactApprovalReference {
  /** Opaque approval record identity. A broad grant is never an approval reference. */
  approvalId: string;
  approvedAt: IsoDateTime;
  actionHash: ContentHash;
}

export interface ArtifactReview {
  id: string;
  status: ArtifactReviewStatus;
  requestedByInternalUserId: InternalUserId;
  reviewerMemberId?: MemberId;
  versionId: ArtifactVersionId;
  requestedAt: IsoDateTime;
  resolvedAt?: IsoDateTime;
  summary?: string;
  requestedChanges?: readonly string[];
  acceptance?: {
    acceptedByInternalUserId: InternalUserId;
    acceptedAt: IsoDateTime;
    note?: string;
  };
}

export interface ArtifactPublication {
  destination: string;
  publishedAt: IsoDateTime;
  /** The exact approval for this publish action, rather than a reusable grant. */
  approval: ExactApprovalReference;
  externalReference?: string;
}

export interface ArtifactRetention {
  status: ArtifactRetentionStatus;
  retainUntil?: IsoDateTime;
  deletionRequestedAt?: IsoDateTime;
  deletedAt?: IsoDateTime;
  exportReference?: string;
}

/** Immutable once created. Content changes always create another version. */
export interface ArtifactVersion {
  id: ArtifactVersionId;
  artifactId: ArtifactId;
  version: number;
  status: ArtifactVersionStatus;
  createdAt: IsoDateTime;
  createdByInternalUserId: InternalUserId;
  content: ArtifactContent;
  media: ArtifactMediaMetadata;
  contentHash: ContentHash;
  provenance: ArtifactSourceProvenance;
  citations: readonly ArtifactCitation[];
  lineage: readonly ArtifactLineageLink[];
  inputs?: readonly ArtifactInputReference[];
  decisions?: readonly ArtifactDecisionReference[];
}

/** Durable artifact identity and mutable presentation/lifecycle state. */
export type Artifact = RecordMetadata & RecordScope & {
  id: ArtifactId;
  kind: ArtifactKind;
  status: ArtifactStatus;
  title: string;
  currentVersionId: ArtifactVersionId;
  producingRunId?: RunId;
  sourceProvenance: readonly ArtifactSourceProvenance[];
  context: ArtifactContext;
  reviews: readonly ArtifactReview[];
  publication?: ArtifactPublication;
  retention: ArtifactRetention;
  legacySources?: readonly LegacySourceProvenance[];
};

export interface ArtifactContext {
  threadId?: ThreadId;
  projectId?: ProjectId;
  goalId?: GoalId;
  missionId?: MissionId;
  departmentId?: DepartmentId;
  pipelineId?: PipelineId;
  routineId?: RoutineId;
}

export interface HandoffContextReference {
  workspaceId: WorkspaceId;
  threadId?: ThreadId;
  projectId?: ProjectId;
  goalId?: GoalId;
  missionId?: MissionId;
  departmentId?: DepartmentId;
  pipelineId?: PipelineId;
  routineId?: RoutineId;
}

/** Canonical native/read-model bundle. Versions are ordered oldest to newest. */
export interface ArtifactBundle {
  artifact: Artifact;
  currentVersion: ArtifactVersion;
  versions: readonly ArtifactVersion[];
  sourceMessageId?: string;
}

/** Editing content appends a version; it never mutates prior content or evidence. */
export interface AppendArtifactVersionInput {
  artifactId: ArtifactId;
  expectedRevision: number;
  expectedCurrentVersionId: ArtifactVersionId;
  title?: string;
  content: ArtifactContent;
}

export interface ArtifactReviewActionInput {
  artifactId: ArtifactId;
  versionId: ArtifactVersionId;
  expectedRevision: number;
  action: "request-review" | "request-changes" | "accept" | "reject" | "withdraw";
  note?: string;
  requestedChanges?: readonly string[];
}

export interface ArtifactSearchQuery {
  query?: string;
  threadId?: ThreadId;
  projectId?: ProjectId;
  kinds?: readonly ArtifactKind[];
  statuses?: readonly ArtifactStatus[];
  limit?: number;
}

export interface ArtifactSearchResult {
  artifact: Artifact;
  currentVersion: ArtifactVersion;
  matchedOn: readonly ("title" | "content" | "source" | "decision")[];
}

/** A secret-free, user-requested export of one exact immutable version. */
export interface ArtifactExport {
  artifactId: ArtifactId;
  versionId: ArtifactVersionId;
  title: string;
  kind: ArtifactKind;
  exportedAt: IsoDateTime;
  content: ArtifactContent;
  citations: readonly ArtifactCitation[];
  inputs: readonly ArtifactInputReference[];
  decisions: readonly ArtifactDecisionReference[];
  lineage: readonly ArtifactLineageLink[];
}

/**
 * A handoff copies only the listed durable references into a receiving context.
 * It cannot transfer hidden conversation, credentials, grants, or authority.
 */
export type ArtifactHandoff = RecordMetadata & RecordScope & {
  id: HandoffId;
  status: HandoffStatus;
  source: HandoffContextReference;
  target: HandoffContextReference;
  artifactVersionIds: readonly ArtifactVersionId[];
  includedContext: readonly HandoffContextReference[];
  authorityTransfer: "none";
  proposedByInternalUserId: InternalUserId;
  proposedAt: IsoDateTime;
  resolvedAt?: IsoDateTime;
  resolvedByInternalUserId?: InternalUserId;
  rejectionReason?: string;
  note?: string;
};

export interface RoutineScope {
  projectId?: ProjectId;
  /** Local teammate that owns this Routine's model, instructions, and private computer scope. */
  agentId?: string;
  departmentId?: DepartmentId;
  pipelineId?: PipelineId;
  goalId?: GoalId;
  threadId?: ThreadId;
  connectionId?: ConnectionId;
}

export interface RoutineActionTemplate {
  kind: "direct-request" | "mission" | "pipeline" | "workflow-compatibility";
  title: string;
  instruction: string;
  missionId?: MissionId;
  pipelineId?: PipelineId;
  legacyWorkflowDefinitionId?: string;
  input?: Readonly<Record<string, unknown>>;
}

export interface RoutineBudgetReferences {
  budgetPolicyRef?: string;
  capabilityGrantIds: readonly CapabilityGrantId[];
}

export type RoutineRoutePolicy =
  | {
      kind: "resolve-at-run";
      /** Candidate routes are preferences, not an authority expansion. */
      preferredProviderRouteIds?: readonly ProviderRouteId[];
    }
  | {
      kind: "deliberate-pin";
      providerRouteId: ProviderRouteId;
      pinnedByInternalUserId: InternalUserId;
      pinnedAt: IsoDateTime;
      reason: string;
    };

export interface RoutinePlacementPolicy {
  kind: "resolve-at-run" | "deliberate-pin";
  preferredExecutionNodeIds?: readonly ExecutionNodeId[];
  pinnedExecutionNodeId?: ExecutionNodeId;
  /** Placement selects a driver; it does not expose that driver's queue state. */
  reason?: string;
}

export interface RoutineDeduplicationPolicy {
  strategy: "per-trigger-event" | "time-window" | "source-reference" | "custom";
  windowMs?: number;
  keyTemplate?: string;
}

export interface TimeOnceTrigger {
  kind: "time-once";
  at: IsoDateTime;
  timezone: string;
}

export interface TimeRecurringTrigger {
  kind: "time-recurring";
  timezone: string;
  recurrence: {
    frequency: "daily" | "weekly" | "monthly" | "cron";
    expression: string;
    until?: IsoDateTime;
  };
  missedRunPolicy: MissedRunPolicy;
}

export interface WebhookTrigger {
  kind: "webhook";
  endpointReference: string;
  verificationPolicyReference: string;
  eventTypes?: readonly string[];
}

export interface ConnectionEventTrigger {
  kind: "connection-event";
  connectionId: ConnectionId;
  eventType: string;
  eventFilter?: Readonly<Record<string, unknown>>;
}

export interface ThresholdTrigger {
  kind: "threshold";
  metricReference: string;
  comparator: "greater-than" | "greater-than-or-equal" | "less-than" | "less-than-or-equal" | "equals";
  value: number;
}

export interface MonitoringTrigger {
  kind: "monitoring";
  monitorReference: string;
  condition: string;
  polling?: { intervalMs: number; timezone?: string };
}

export interface FollowUpTrigger {
  kind: "follow-up";
  after: { runId?: RunId; artifactVersionId?: ArtifactVersionId; routineId?: RoutineId };
  delayMs?: number;
  condition?: string;
}

export type RoutineTriggerSpec =
  | TimeOnceTrigger
  | TimeRecurringTrigger
  | WebhookTrigger
  | ConnectionEventTrigger
  | ThresholdTrigger
  | MonitoringTrigger
  | FollowUpTrigger;

export type RoutineTrigger = RecordMetadata & RecordScope & {
  id: TriggerId;
  routineId: RoutineId;
  status: TriggerStatus;
  spec: RoutineTriggerSpec;
  deduplication: RoutineDeduplicationPolicy;
  legacySources?: readonly LegacySourceProvenance[];
};

/** Version snapshots are immutable; editing a routine produces the next version. */
export interface RoutineVersion {
  routineId: RoutineId;
  version: number;
  createdAt: IsoDateTime;
  createdByInternalUserId: InternalUserId;
  action: RoutineActionTemplate;
  scope: RoutineScope;
  routePolicy: RoutineRoutePolicy;
  placementPolicy: RoutinePlacementPolicy;
  budgets: RoutineBudgetReferences;
  triggerIds: readonly TriggerId[];
}

/** Contextual reusable work. Automation never grants broader authority. */
export type Routine = RecordMetadata & RecordScope & {
  id: RoutineId;
  status: RoutineStatus;
  title: string;
  currentVersion: number;
  ownerMemberId?: MemberId;
  scope: RoutineScope;
  authorityPolicy: "no-expansion";
  pause?: { pausedAt: IsoDateTime; pausedByInternalUserId: InternalUserId; reason?: string };
  legacySources?: readonly LegacySourceProvenance[];
};

/** Portable occurrence/history reference. Queue, lease, permit, and fencing data stay driver-local. */
export interface RoutineOccurrenceReference {
  id: string;
  routineId: RoutineId;
  triggerId: TriggerId;
  routineVersion: number;
  status: RoutineOccurrenceStatus;
  scheduledFor?: IsoDateTime;
  observedAt: IsoDateTime;
  deduplicationKey: string;
  runId?: RunId;
  result?: RoutineResultReference;
  legacySources?: readonly LegacySourceProvenance[];
}

/** A portable history projection, never a scheduler queue or lease ledger. */
export interface RoutineOccurrenceHistory {
  routineId: RoutineId;
  occurrences: readonly RoutineOccurrenceReference[];
  nextOccurrenceAt?: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface RoutineResultReference {
  status: "succeeded" | "failed" | "cancelled" | "blocked";
  completedAt: IsoDateTime;
  artifactVersionIds?: readonly ArtifactVersionId[];
  error?: ContractError;
}

export const CONTRACT_ERROR_CODES = [
  "conflict",
  "invalid",
  "not-found",
  "not-authorized",
  "not-allowed",
  "precondition-failed",
  "retention-blocked",
  "unavailable"
] as const;
export type ContractErrorCode = (typeof CONTRACT_ERROR_CODES)[number];

export interface ContractError {
  code: ContractErrorCode;
  message: string;
  retryable: boolean;
  details?: Readonly<Record<string, unknown>>;
}

/** A result is always discriminated; a value and an error can never coexist. */
export type ContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ContractError };

export interface CreateEnvelope<T> {
  clientMutationId: string;
  idempotencyKey: string;
  value: T;
}

export interface UpdateEnvelope<T, ImmutableKeys extends keyof T = never> {
  clientMutationId: string;
  idempotencyKey: string;
  baseRevision: number;
  /** Immutable identity, scope, provenance, and authority are never patchable. */
  patch: Partial<Omit<T, ImmutableKeys>>;
}

export interface TransitionEnvelope<Status extends string> {
  clientMutationId: string;
  idempotencyKey: string;
  baseRevision: number;
  to: Status;
  reason?: string;
}

export type ArtifactCreateEnvelope = CreateEnvelope<Artifact>;
type CanonicalRecordImmutableKeys =
  | "id"
  | "workspaceId"
  | "authority"
  | "schemaVersion"
  | "revision"
  | "createdByInternalUserId"
  | "createdByDeviceId"
  | "createdAt"
  | "visibility"
  | "ownerMemberId";

export type ArtifactUpdateEnvelope = UpdateEnvelope<Artifact, CanonicalRecordImmutableKeys>;
export type ArtifactTransitionEnvelope = TransitionEnvelope<ArtifactStatus>;
export type ArtifactCreateResult = ContractResult<Artifact>;
export type ArtifactTransitionResult = ContractResult<Artifact>;
export type ArtifactBundleResult = ContractResult<ArtifactBundle>;
export type ArtifactAppendVersionResult = ContractResult<ArtifactBundle>;
export type ArtifactReviewActionResult = ContractResult<ArtifactBundle>;
export type ArtifactSearchResultPage = ContractResult<readonly ArtifactSearchResult[]>;
export type ArtifactExportResult = ContractResult<ArtifactExport>;

export type ArtifactHandoffCreateEnvelope = CreateEnvelope<ArtifactHandoff>;
export type ArtifactHandoffTransitionEnvelope = TransitionEnvelope<HandoffStatus>;
export type ArtifactHandoffResult = ContractResult<ArtifactHandoff>;
export type ArtifactHandoffProposalEnvelope = CreateEnvelope<ArtifactHandoff>;
export type ArtifactHandoffAcceptEnvelope = TransitionEnvelope<"accepted">;
export type ArtifactHandoffRejectEnvelope = TransitionEnvelope<"rejected">;

export type RoutineCreateEnvelope = CreateEnvelope<Routine>;
export type RoutineUpdateEnvelope = UpdateEnvelope<Routine, CanonicalRecordImmutableKeys>;
export type RoutineTransitionEnvelope = TransitionEnvelope<RoutineStatus>;
export type RoutinePauseEnvelope = TransitionEnvelope<"paused">;
export type RoutineResumeEnvelope = TransitionEnvelope<"active">;
export type RoutineTriggerCreateEnvelope = CreateEnvelope<RoutineTrigger>;
export type RoutineTriggerTransitionEnvelope = TransitionEnvelope<TriggerStatus>;
export type RoutineOccurrenceResult = ContractResult<RoutineOccurrenceReference>;

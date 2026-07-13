import type {
  ArtifactId,
  ArtifactVersionId,
  CapabilityGrantId,
  CapabilityId,
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
  PlanId,
  PlanRevisionId,
  ProjectId,
  ProviderRouteId,
  RecordScope,
  Revision,
  RoutineId,
  RunEventId,
  RunId,
  SchemaVersion,
  ScopedRecordMetadata,
  ThreadId,
  WorkerId,
  WorkspaceId
} from "./primitives.js";

/** Fable chooses this depth; it is never a required user-facing mode. */
export const EXECUTION_DEPTHS = ["direct", "delegated", "multi-worker"] as const;
export type ExecutionDepth = (typeof EXECUTION_DEPTHS)[number];

export const MISSION_STATUSES = [
  "proposed",
  "planning",
  "ready",
  "running",
  "waiting",
  "completed",
  "partially-completed",
  "failed",
  "cancelled",
  "archived"
] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

export const PLAN_STATUSES = ["draft", "current", "superseded", "withdrawn"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_REVISION_REASONS = [
  "initial",
  "scope-changed",
  "constraint-changed",
  "new-evidence",
  "worker-feedback",
  "approval-result",
  "recovery",
  "manual-revision"
] as const;
export type PlanRevisionReason = (typeof PLAN_REVISION_REASONS)[number];

export const PLAN_STEP_KINDS = ["investigate", "produce", "act", "review", "coordinate"] as const;
export type PlanStepKind = (typeof PLAN_STEP_KINDS)[number];

export const WORKER_ROLE_KINDS = [
  "orchestrator",
  "specialist",
  "executor",
  "reviewer",
  "coordinator"
] as const;
export type WorkerRoleKind = (typeof WORKER_ROLE_KINDS)[number];

export const WORKER_STATUSES = [
  "proposed",
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled"
] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export const RUN_KINDS = ["direct", "mission", "routine", "pipeline"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_STATUSES = [
  "created",
  "planning",
  "queued",
  "running",
  "waiting-approval",
  "waiting-human-input",
  "paused",
  "retrying",
  "cancelling",
  "completed",
  "partially-completed",
  "failed",
  "cancelled"
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_ATTEMPT_STATUSES = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "superseded"
] as const;
export type RunAttemptStatus = (typeof RUN_ATTEMPT_STATUSES)[number];

export const RUN_OUTCOME_KINDS = ["succeeded", "partial", "failed", "cancelled"] as const;
export type RunOutcomeKind = (typeof RUN_OUTCOME_KINDS)[number];

export const WAIT_KINDS = ["approval", "human-input"] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

export const WAIT_STATUSES = ["pending", "resolved", "denied", "expired", "cancelled"] as const;
export type WaitStatus = (typeof WAIT_STATUSES)[number];

export const APPROVAL_WAIT_DECISIONS = ["approved", "modified", "denied", "expired", "cancelled"] as const;
export type ApprovalWaitDecision = (typeof APPROVAL_WAIT_DECISIONS)[number];

export const CHECKPOINT_KINDS = ["automatic", "worker-boundary", "wait-boundary", "manual", "recovery"] as const;
export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];

export const JOIN_STRATEGIES = ["all", "any", "quorum"] as const;
export type JoinStrategy = (typeof JOIN_STRATEGIES)[number];

export const JOIN_STATUSES = ["open", "satisfied", "timed-out", "cancelled"] as const;
export type JoinStatus = (typeof JOIN_STATUSES)[number];

export const EVALUATION_VERDICTS = ["pass", "pass-with-notes", "revise", "fail", "inconclusive"] as const;
export type EvaluationVerdict = (typeof EVALUATION_VERDICTS)[number];

export const COST_PROVENANCE_KINDS = ["provider-reported", "fable-calculated", "estimated", "unknown"] as const;
export type CostProvenanceKind = (typeof COST_PROVENANCE_KINDS)[number];

export const REPLAY_POLICIES = ["never-replay", "deduplicate", "safe-repeat"] as const;
export type ReplayPolicy = (typeof REPLAY_POLICIES)[number];

export const SIDE_EFFECT_OUTCOMES = ["committed", "deduplicated", "not-applied", "unknown"] as const;
export type SideEffectOutcome = (typeof SIDE_EFFECT_OUTCOMES)[number];

export const CONTRACT_ERROR_CATEGORIES = [
  "validation",
  "authorization",
  "approval",
  "capability-unavailable",
  "route-unavailable",
  "placement-unavailable",
  "budget-exceeded",
  "conflict",
  "cancelled",
  "interrupted",
  "provider",
  "tool",
  "storage",
  "internal"
] as const;
export type ContractErrorCategory = (typeof CONTRACT_ERROR_CATEGORIES)[number];

/** References select context; they never carry authority or hidden history. */
export type WorkContextReference =
  | { kind: "thread"; threadId: ThreadId }
  | { kind: "project"; projectId: ProjectId }
  | { kind: "goal"; goalId: GoalId }
  | { kind: "department"; departmentId: DepartmentId }
  | { kind: "pipeline"; pipelineId: PipelineId }
  | { kind: "artifact"; artifactId: ArtifactId; versionId?: ArtifactVersionId }
  | { kind: "connection"; connectionId: ConnectionId }
  | { kind: "knowledge" | "memory" | "message" | "external-source"; reference: string };

export interface MissionOutcome {
  title: string;
  desiredOutcome: string;
  deliverables: readonly ExpectedDeliverable[];
}

export interface ExpectedDeliverable {
  key: string;
  description: string;
  format?: string;
  required: boolean;
}

export interface MissionScope {
  sourceThreadId?: ThreadId;
  goalId?: GoalId;
  projectId?: ProjectId;
  departmentIds: readonly DepartmentId[];
  pipelineId?: PipelineId;
  context: readonly WorkContextReference[];
}

export interface TimeConstraint {
  notBefore?: IsoDateTime;
  deadline?: IsoDateTime;
  maxDurationMs?: number;
}

export interface DataBoundaryConstraint {
  classification?: string;
  allowedExecutionNodeIds?: readonly ExecutionNodeId[];
  allowedProviderRouteIds?: readonly ProviderRouteId[];
  prohibitedDestinationPatterns?: readonly string[];
  localOnly?: boolean;
}

export interface MissionConstraint {
  key: string;
  description: string;
  severity: "required" | "preferred";
  source: "user" | "workspace-policy" | "project" | "department" | "pipeline" | "orchestrator";
}

export interface AcceptanceCriterion {
  key: string;
  description: string;
  required: boolean;
  evaluator: "human" | "worker" | "policy" | "external";
  evidenceRequired?: readonly string[];
}

export interface MissionAcceptance {
  criteria: readonly AcceptanceCriterion[];
  requiresHumanAcceptance: boolean;
  minimumRequiredCriteria?: number;
}

export interface MonetaryAmount {
  /** Decimal text avoids binary floating-point drift across TypeScript and Rust. */
  amount: string;
  currencyCode: string;
}

export interface ExecutionBudget {
  maxDurationMs?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxToolCalls?: number;
  maxWorkers?: number;
  maxAttempts?: number;
  maxCost?: MonetaryAmount;
}

/** A Mission is optional and is never synthesized merely to represent a direct run. */
export type Mission = ScopedRecordMetadata & {
  id: MissionId;
  status: MissionStatus;
  executionDepth: Exclude<ExecutionDepth, "direct">;
  outcome: MissionOutcome;
  scope: MissionScope;
  constraints: readonly MissionConstraint[];
  timeConstraint?: TimeConstraint;
  dataBoundary?: DataBoundaryConstraint;
  acceptance: MissionAcceptance;
  budget?: ExecutionBudget;
  currentPlanId?: PlanId;
  currentPlanRevisionId?: PlanRevisionId;
  /** A direct run may escalate to this mission, but retains its own identity. */
  escalatedFromRunId?: RunId;
  terminalResult?: MissionResult;
}

/** One stable plan identity belongs to exactly one mission and points at at most one current revision. */
export type MissionPlan = ScopedRecordMetadata & {
  id: PlanId;
  missionId: MissionId;
  status: PlanStatus;
  currentRevisionId?: PlanRevisionId;
  currentRevisionNumber: number;
}

export interface PlanBounds {
  maxSteps: number;
  maxDependenciesPerStep: number;
  maxParallelSteps: number;
  maxRevisions?: number;
}

export interface PlanStep {
  /** Unique only within this plan revision; it is not a global product ID. */
  key: string;
  kind: PlanStepKind;
  title: string;
  objective: string;
  dependsOnStepKeys: readonly string[];
  requiredCapabilities: readonly CapabilityId[];
  expectedOutputs: readonly ExpectedDeliverable[];
  acceptanceCriterionKeys: readonly string[];
  optional: boolean;
  estimatedBudget?: ExecutionBudget;
}

/**
 * Immutable, mission-generated proposal snapshot rather than a reusable
 * user-authored graph. Bounds and dependency references are validated before
 * persistence. The metadata revision is storage revision, not planRevisionNumber.
 */
export type PlanRevision = Readonly<Omit<ScopedRecordMetadata, "deletedAt">> & {
  readonly deletedAt?: never;
  readonly id: PlanRevisionId;
  readonly planId: PlanId;
  readonly missionId: MissionId;
  readonly planRevisionNumber: number;
  readonly supersedesRevisionId?: PlanRevisionId;
  readonly reason: PlanRevisionReason;
  readonly summary: string;
  readonly bounds: PlanBounds;
  readonly steps: readonly PlanStep[];
  readonly createdForRunId?: RunId;
};

export interface WorkerRole {
  kind: WorkerRoleKind;
  title: string;
  objective: string;
  responsibilities: readonly string[];
}

export interface WorkerContextReference {
  reference: WorkContextReference;
  purpose: string;
  required: boolean;
  trust: "trusted" | "untrusted" | "mixed";
  maxCharacters?: number;
}

export interface WorkerToolRequirement {
  /** Adapter-owned tool name; semantic authority comes from capabilities/grants. */
  toolName: string;
  access: "read" | "draft" | "write" | "execute";
  purpose: string;
  required: boolean;
}

export interface ProviderRoutePreference {
  policy: "automatic" | "prefer" | "require" | "exclude";
  providerRouteIds: readonly ProviderRouteId[];
  allowFallback: boolean;
  reason?: string;
}

export interface ExecutionPlacementPreference {
  policy: "automatic" | "prefer" | "require" | "exclude";
  executionNodeIds: readonly ExecutionNodeId[];
  locality?: "local" | "hosted" | "customer-hosted";
  allowTransfer: boolean;
  reason?: string;
}

export interface WorkerStopCondition {
  kind: "objective-met" | "budget-reached" | "deadline" | "no-progress" | "human-stop" | "policy-stop";
  description: string;
  threshold?: number;
}

export interface WorkerOutputSlot {
  key: string;
  description: string;
  required: boolean;
  format?: string;
}

export interface WorkerOutputContract {
  slots: readonly WorkerOutputSlot[];
  includeEvidence: boolean;
  includeUncertainty: boolean;
  delivery: "run-result" | "handoff" | "join";
}

export interface WorkerHandoffContract {
  required: boolean;
  recipient: "orchestrator" | "worker" | "human" | "external";
  recipientWorkerId?: WorkerId;
  requiredSections: readonly string[];
  acceptedArtifactKinds?: readonly string[];
}

export interface ProviderRouteObservationSnapshot {
  reference: string;
  sampleCount: number;
  medianLatencyMs: number;
  usageSampleCount: number;
  latestObservedAt: IsoDateTime;
}

export interface ProviderRouteQualitySnapshot {
  reference: string;
  policyRevisionRef: string;
  sampleCount: number;
  passedCount: number;
  routingScoreBasisPoints: number;
  latestEvaluatedAt: IsoDateTime;
}

/** Exact native acceptance contract used by the current cited-brief evaluator. */
// Digest input: native-cited-brief-policy:v1|receipt.version=2|trust=provider-generated-with-external-evidence|citations.nonempty|requiredEvidence.subset
export const NATIVE_CITED_BRIEF_POLICY_REVISION =
  "native-policy:cited-brief:v1:2c6c266fe616417ded9cf81a667dddca7a5590204e84c708b1f4ca32d6eb5527";

export interface ProviderRoutePricingEvidence {
  reference: string;
  currencyCode: string;
  inputRateMinorUnits: number;
  outputRateMinorUnits: number;
  unitTokens: number;
  sourceUrl: string;
  reviewedAt: IsoDateTime;
}

export interface ProviderRouteCostSnapshot extends ProviderRoutePricingEvidence {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostMinorUnits: number;
}

export interface ProviderRouteSelection {
  providerRouteId: ProviderRouteId;
  selectedAt: IsoDateTime;
  reason: string;
  fallbackFromProviderRouteId?: ProviderRouteId;
  boundaryPolicyRef?: string;
  observation?: ProviderRouteObservationSnapshot;
  quality?: ProviderRouteQualitySnapshot;
  cost?: ProviderRouteCostSnapshot;
}

export interface ExecutionNodeSelection {
  executionNodeId: ExecutionNodeId;
  selectedAt: IsoDateTime;
  reason: string;
  transferredFromExecutionNodeId?: ExecutionNodeId;
  boundaryPolicyRef?: string;
}

/** Workers are owned by exactly one run; direct runs may own zero workers. */
export type Worker = ScopedRecordMetadata & {
  id: WorkerId;
  runId: RunId;
  status: WorkerStatus;
  role: WorkerRole;
  parentWorkerId?: WorkerId;
  planRevisionId?: PlanRevisionId;
  planStepKey?: string;
  context: readonly WorkerContextReference[];
  capabilityIds: readonly CapabilityId[];
  capabilityGrantIds: readonly CapabilityGrantId[];
  tools: readonly WorkerToolRequirement[];
  routePreference?: ProviderRoutePreference;
  placementPreference?: ExecutionPlacementPreference;
  selectedRoute?: ProviderRouteSelection;
  selectedPlacement?: ExecutionNodeSelection;
  budget: ExecutionBudget;
  stopConditions: readonly WorkerStopCondition[];
  outputContract: WorkerOutputContract;
  handoffContract?: WorkerHandoffContract;
}

export type DirectRunInitiator =
  {
    kind: "direct";
    requestKey: string;
    threadId?: ThreadId;
    requestPreview?: string;
  };

export type MissionRunInitiator = { kind: "mission"; missionId: MissionId };
export type RoutineRunInitiator = { kind: "routine"; routineId: RoutineId; occurrenceKey: string };
export type PipelineRunInitiator = {
  kind: "pipeline";
  pipelineId: PipelineId;
  executionKey: string;
  missionId?: MissionId;
};

export type RunInitiator =
  | DirectRunInitiator
  | MissionRunInitiator
  | RoutineRunInitiator
  | PipelineRunInitiator;

export type RunClassification =
  | {
      kind: "direct";
      executionDepth: "direct";
      initiator: DirectRunInitiator;
    }
  | {
      kind: "mission";
      executionDepth: Exclude<ExecutionDepth, "direct">;
      initiator: MissionRunInitiator;
    }
  | { kind: "routine"; executionDepth: ExecutionDepth; initiator: RoutineRunInitiator }
  | { kind: "pipeline"; executionDepth: ExecutionDepth; initiator: PipelineRunInitiator };

export type RunParentage =
  | { kind: "root" }
  | { kind: "retry"; parentRunId: RunId; rootRunId: RunId; retryOrdinal: number }
  | {
      kind: "child";
      parentRunId: RunId;
      rootRunId: RunId;
      parentWorkerId?: WorkerId;
      purpose: string;
    };

export interface RunEventHead {
  lastSequence: number;
  lastEventId?: RunEventId;
}

type RunRecord = ScopedRecordMetadata & {
  id: RunId;
  status: RunStatus;
  parentage: RunParentage;
  sourceThreadId?: ThreadId;
  projectId?: ProjectId;
  goalId?: GoalId;
  departmentIds: readonly DepartmentId[];
  planRevisionId?: PlanRevisionId;
  budget: ExecutionBudget;
  currentAttemptNumber?: number;
  eventHead: RunEventHead;
  cancellation?: CancellationRequest;
  terminalResult?: RunResult;
}

/** One inspectable execution. Classification ties its depth to exactly one initiating cause. */
export type Run = RunRecord & RunClassification;

/** Attempts have composite identity (runId, attemptNumber), not a second RunId. */
export interface RunAttempt {
  runId: RunId;
  attemptNumber: number;
  status: RunAttemptStatus;
  previousAttemptNumber?: number;
  retryReason?: ContractError;
  selectedRoute?: ProviderRouteSelection;
  selectedPlacement: ExecutionNodeSelection;
  resumedFromCheckpointEventId?: RunEventId;
  startedAt?: IsoDateTime;
  finishedAt?: IsoDateTime;
}

export interface CancellationRequest {
  requestKey: string;
  requestedAt: IsoDateTime;
  requestedByInternalUserId?: InternalUserId;
  requestedByWorkerId?: WorkerId;
  scope: "run" | "attempt" | "worker";
  attemptNumber?: number;
  workerId?: WorkerId;
  reason?: string;
  mode: "cooperative" | "immediate-if-safe";
}

export interface ApprovalWait {
  waitKey: string;
  status: WaitStatus;
  approvalRequestRef: string;
  proposalHash: string;
  actionSummary: string;
  requestedAt: IsoDateTime;
  expiresAt?: IsoDateTime;
  workerId?: WorkerId;
  sideEffect?: SideEffectBoundary;
}

export interface ApprovalWaitResolution {
  waitKey: string;
  decision: ApprovalWaitDecision;
  decidedAt: IsoDateTime;
  decidedByInternalUserId?: InternalUserId;
  acceptedProposalHash: string;
  replacementApprovalRequestRef?: string;
}

export const HUMAN_INPUT_FIELD_KINDS = ["text", "number", "boolean", "choice", "date-time", "artifact"] as const;
export type HumanInputFieldKind = (typeof HUMAN_INPUT_FIELD_KINDS)[number];

export interface HumanInputField {
  key: string;
  label: string;
  kind: HumanInputFieldKind;
  required: boolean;
  choices?: readonly string[];
  sensitive: boolean;
}

export interface HumanInputWait {
  waitKey: string;
  status: WaitStatus;
  prompt: string;
  fields: readonly HumanInputField[];
  requestedAt: IsoDateTime;
  expiresAt?: IsoDateTime;
  workerId?: WorkerId;
}

export interface HumanInputValue {
  fieldKey: string;
  value: string | number | boolean | ArtifactId | null;
}

export interface HumanInputResolution {
  waitKey: string;
  receivedAt: IsoDateTime;
  suppliedByInternalUserId: InternalUserId;
  values: readonly HumanInputValue[];
}

export interface SideEffectBoundary {
  effectKey: string;
  idempotencyKey: string;
  replayPolicy: ReplayPolicy;
  proposalHash: string;
  capabilityId?: CapabilityId;
  connectionId?: ConnectionId;
  targetSummary: string;
  /** References an approval record; never an execution permit or credential. */
  approvalRequestRef?: string;
}

export interface SideEffectReceipt {
  boundary: SideEffectBoundary;
  outcome: SideEffectOutcome;
  committedAt?: IsoDateTime;
  externalReceiptRef?: string;
  error?: ContractError;
}

export interface ReplayBoundary {
  durableThroughSequence: number;
  resumeAfterEventId: RunEventId;
  completedPlanStepKeys: readonly string[];
  completedWorkerIds: readonly WorkerId[];
  committedEffectKeys: readonly string[];
}

/** The containing checkpoint-created event is the checkpoint's durable identity. */
export interface RunCheckpoint {
  kind: CheckpointKind;
  attemptNumber: number;
  createdAt: IsoDateTime;
  replayBoundary: ReplayBoundary;
  stateStorage: "node-local" | "portable-redacted";
  stateReference: string;
  stateHash: string;
  executionNodeId: ExecutionNodeId;
  pendingWaitKey?: string;
}

export interface WorkerJoin {
  joinKey: string;
  status: JoinStatus;
  strategy: JoinStrategy;
  workerIds: readonly WorkerId[];
  quorum?: number;
  allowFailedWorkers: boolean;
  deadline?: IsoDateTime;
  satisfiedWorkerIds: readonly WorkerId[];
  failedWorkerIds: readonly WorkerId[];
}

export interface EvaluationCriterionResult {
  criterionKey: string;
  passed: boolean | null;
  score?: number;
  summary: string;
  evidenceRefs: readonly string[];
}

export type EvaluationTarget =
  | { kind: "run"; runId: RunId }
  | { kind: "worker"; workerId: WorkerId }
  | { kind: "artifact"; artifactId: ArtifactId; versionId?: ArtifactVersionId }
  | { kind: "handoff"; handoffId: HandoffId };

export interface EvaluationResult {
  evaluationKey: string;
  target: EvaluationTarget;
  reviewerWorkerId?: WorkerId;
  reviewerInternalUserId?: InternalUserId;
  verdict: EvaluationVerdict;
  score?: number;
  criteria: readonly EvaluationCriterionResult[];
  summary: string;
  recommendedAction?: "accept" | "revise" | "retry" | "escalate" | "stop";
  evaluatedAt: IsoDateTime;
}

export interface CostMeasurement {
  amount: MonetaryAmount;
  provenance: CostProvenanceKind;
  pricingReference?: string;
}

export interface UsageMeasurement {
  usageKey: string;
  runId: RunId;
  attemptNumber?: number;
  workerId?: WorkerId;
  providerRouteId?: ProviderRouteId;
  executionNodeId?: ExecutionNodeId;
  modelReference?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  toolCalls?: number;
  durationMs?: number;
  costs: readonly CostMeasurement[];
  measuredAt: IsoDateTime;
}

export interface ProducedOutput {
  key: string;
  summary: string;
  artifactId?: ArtifactId;
  artifactVersionId?: ArtifactVersionId;
  handoffId?: HandoffId;
  valueReference?: string;
}

export interface AcceptanceResult {
  criterionKey: string;
  status: "met" | "partially-met" | "not-met" | "not-evaluated";
  evidenceRefs: readonly string[];
  summary?: string;
}

export interface PartialOutcome {
  summary: string;
  completedOutputs: readonly ProducedOutput[];
  remainingWork: readonly string[];
  acceptance: readonly AcceptanceResult[];
  recoverable: boolean;
  recommendedNextAction?: "resume" | "retry" | "revise-plan" | "human-review" | "stop";
}

export interface RunResult {
  outcome: RunOutcomeKind;
  summary: string;
  outputs: readonly ProducedOutput[];
  acceptance: readonly AcceptanceResult[];
  evaluations: readonly EvaluationResult[];
  usage: readonly UsageMeasurement[];
  partial?: PartialOutcome;
  error?: ContractError;
  completedAt: IsoDateTime;
}

export interface MissionResult {
  outcome: RunOutcomeKind;
  summary: string;
  producingRunIds: readonly RunId[];
  outputs: readonly ProducedOutput[];
  acceptance: readonly AcceptanceResult[];
  partial?: PartialOutcome;
  completedAt: IsoDateTime;
}

export interface ContractErrorDetail {
  key: string;
  value: string;
}

export interface ContractError {
  code: string;
  category: ContractErrorCategory;
  message: string;
  retryable: boolean;
  safeDetails?: readonly ContractErrorDetail[];
  causedByEventId?: RunEventId;
  providerRouteId?: ProviderRouteId;
  executionNodeId?: ExecutionNodeId;
}

export const RUN_EVENT_TYPES = [
  "run-created",
  "status-transitioned",
  "mission-linked",
  "planning-started",
  "plan-revision-selected",
  "attempt-started",
  "attempt-finished",
  "route-selected",
  "placement-selected",
  "worker-created",
  "worker-started",
  "worker-progressed",
  "worker-waiting",
  "worker-completed",
  "worker-failed",
  "tool-call-proposed",
  "tool-call-completed",
  "tool-call-failed",
  "side-effect-recorded",
  "approval-requested",
  "approval-resolved",
  "human-input-requested",
  "human-input-received",
  "checkpoint-created",
  "checkpoint-restored",
  "handoff-created",
  "join-opened",
  "join-resolved",
  "evaluation-recorded",
  "artifact-produced",
  "usage-recorded",
  "retry-scheduled",
  "cancellation-requested",
  "partial-outcome-recorded",
  "run-completed",
  "run-failed",
  "run-cancelled",
  "legacy-imported"
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export type RunEventActor =
  | { kind: "system" }
  | { kind: "internal-user"; internalUserId: InternalUserId; memberId?: MemberId }
  | { kind: "worker"; workerId: WorkerId }
  | { kind: "execution-node"; executionNodeId: ExecutionNodeId }
  | { kind: "provider-route"; providerRouteId: ProviderRouteId }
  | { kind: "legacy-import"; source: string };

export interface ToolCallProposal {
  callKey: string;
  workerId?: WorkerId;
  toolName: string;
  inputHash: string;
  inputReference?: string;
  sideEffect?: SideEffectBoundary;
}

export interface ToolCallResult {
  callKey: string;
  workerId?: WorkerId;
  toolName: string;
  outputReference?: string;
  outputHash?: string;
  durationMs?: number;
}

export interface RunEventPayloadByType {
  "run-created": { run: Run };
  "status-transitioned": { from: RunStatus; to: RunStatus; reason?: string };
  "mission-linked": { missionId: MissionId; escalatedFromDirect: boolean };
  "planning-started": { missionId: MissionId; planId: PlanId };
  "plan-revision-selected": { planId: PlanId; planRevisionId: PlanRevisionId; reason: string };
  "attempt-started": { attempt: RunAttempt };
  "attempt-finished": { attempt: RunAttempt };
  "route-selected": { workerId?: WorkerId; selection: ProviderRouteSelection };
  "placement-selected": { workerId?: WorkerId; selection: ExecutionNodeSelection };
  "worker-created": { worker: Worker };
  "worker-started": { workerId: WorkerId };
  "worker-progressed": { workerId: WorkerId; summary: string; progress?: number };
  "worker-waiting": { workerId: WorkerId; waitKind: WaitKind; waitKey: string };
  "worker-completed": { workerId: WorkerId; outputs: readonly ProducedOutput[] };
  "worker-failed": { workerId: WorkerId; error: ContractError; partial?: PartialOutcome };
  "tool-call-proposed": { proposal: ToolCallProposal };
  "tool-call-completed": { result: ToolCallResult };
  "tool-call-failed": { callKey: string; toolName: string; error: ContractError };
  "side-effect-recorded": { receipt: SideEffectReceipt };
  "approval-requested": { wait: ApprovalWait };
  "approval-resolved": { resolution: ApprovalWaitResolution };
  "human-input-requested": { wait: HumanInputWait };
  "human-input-received": { resolution: HumanInputResolution };
  "checkpoint-created": { checkpoint: RunCheckpoint };
  "checkpoint-restored": { checkpointEventId: RunEventId; newAttemptNumber: number };
  "handoff-created": { handoffId: HandoffId; fromWorkerId?: WorkerId; toWorkerId?: WorkerId };
  "join-opened": { join: WorkerJoin };
  "join-resolved": { join: WorkerJoin };
  "evaluation-recorded": { evaluation: EvaluationResult };
  "artifact-produced": { artifactId: ArtifactId; versionId?: ArtifactVersionId; workerId?: WorkerId };
  "usage-recorded": { usage: UsageMeasurement };
  "retry-scheduled": {
    nextAttemptNumber?: number;
    childRunId?: RunId;
    retryAt?: IsoDateTime;
    error: ContractError;
  };
  "cancellation-requested": { cancellation: CancellationRequest };
  "partial-outcome-recorded": { partial: PartialOutcome };
  "run-completed": { result: RunResult };
  "run-failed": { error: ContractError; partial?: PartialOutcome };
  "run-cancelled": { cancellation: CancellationRequest; partial?: PartialOutcome };
  "legacy-imported": { sourceKind: string; sourceRecordId: string; preservedEvidenceRefs: readonly string[] };
}

/**
 * Immutable append-only fact. Sequence is strictly increasing within one run;
 * previousEventId links sequence N to N-1. Idempotency deduplicates appends but
 * never grants execution authority.
 */
export type RunEventEnvelope<Type extends RunEventType> = Readonly<
  Omit<ScopedRecordMetadata, "deletedAt">
> & {
  readonly deletedAt?: never;
  readonly id: RunEventId;
  readonly runId: RunId;
  readonly type: Type;
  readonly sequence: number;
  readonly previousEventId?: RunEventId;
  readonly attemptNumber?: number;
  readonly occurredAt: IsoDateTime;
  readonly actor: RunEventActor;
  readonly causationEventId?: RunEventId;
  readonly correlationKey?: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<RunEventPayloadByType[Type]>;
};

export type RunEvent = {
  [Type in RunEventType]: RunEventEnvelope<Type>;
}[RunEventType];

export interface ContractRequestMetadata {
  requestId: string;
  workspaceId: WorkspaceId;
  requestedByInternalUserId: InternalUserId;
  requestedAt: IsoDateTime;
  schemaVersion: SchemaVersion;
  idempotencyKey: string;
  expectedRevision?: Revision;
}

export interface MissionCreateInput {
  scope: RecordScope;
  executionDepth: Exclude<ExecutionDepth, "direct">;
  outcome: MissionOutcome;
  missionScope: MissionScope;
  constraints: readonly MissionConstraint[];
  timeConstraint?: TimeConstraint;
  dataBoundary?: DataBoundaryConstraint;
  acceptance: MissionAcceptance;
  budget?: ExecutionBudget;
  escalatedFromRunId?: RunId;
}

export interface RunCreateInput {
  scope: RecordScope;
  parentage: RunParentage;
  sourceThreadId?: ThreadId;
  projectId?: ProjectId;
  goalId?: GoalId;
  departmentIds: readonly DepartmentId[];
  planRevisionId?: PlanRevisionId;
  budget: ExecutionBudget;
}

export type ClassifiedRunCreateInput = RunCreateInput & RunClassification;

export interface WorkerCreateInput {
  scope: RecordScope;
  runId: RunId;
  role: WorkerRole;
  parentWorkerId?: WorkerId;
  planRevisionId?: PlanRevisionId;
  planStepKey?: string;
  context: readonly WorkerContextReference[];
  capabilityIds: readonly CapabilityId[];
  capabilityGrantIds: readonly CapabilityGrantId[];
  tools: readonly WorkerToolRequirement[];
  routePreference?: ProviderRoutePreference;
  placementPreference?: ExecutionPlacementPreference;
  budget: ExecutionBudget;
  stopConditions: readonly WorkerStopCondition[];
  outputContract: WorkerOutputContract;
  handoffContract?: WorkerHandoffContract;
}

export interface PlanRevisionCreateInput {
  scope: RecordScope;
  missionId: MissionId;
  planId: PlanId;
  supersedesRevisionId?: PlanRevisionId;
  reason: PlanRevisionReason;
  summary: string;
  bounds: PlanBounds;
  steps: readonly PlanStep[];
  createdForRunId?: RunId;
}

export interface MissionPlanCreateInput {
  scope: RecordScope;
  missionId: MissionId;
}

export interface CreationEnvelope<Kind extends string, Input> {
  kind: Kind;
  metadata: ContractRequestMetadata;
  input: Input;
}

export type MissionCreationEnvelope = CreationEnvelope<"mission", MissionCreateInput>;
export type MissionPlanCreationEnvelope = CreationEnvelope<"plan", MissionPlanCreateInput>;
export type RunCreationEnvelope = CreationEnvelope<"run", ClassifiedRunCreateInput>;
export type WorkerCreationEnvelope = CreationEnvelope<"worker", WorkerCreateInput>;
export type PlanRevisionCreationEnvelope = CreationEnvelope<"plan-revision", PlanRevisionCreateInput>;

export type CreationResult<RecordType> =
  | { status: "created"; record: RecordType; replayed: boolean }
  | { status: "rejected"; error: ContractError };

export type MissionCreationResult = CreationResult<Mission>;
export type MissionPlanCreationResult = CreationResult<MissionPlan>;
export type RunCreationResult = CreationResult<Run>;
export type WorkerCreationResult = CreationResult<Worker>;
export type PlanRevisionCreationResult = CreationResult<PlanRevision>;

export interface StatusTransition<Status extends string> {
  from: Status;
  to: Status;
  reason?: string;
}

export interface TransitionEnvelope<Kind extends string, Transition> {
  kind: Kind;
  metadata: ContractRequestMetadata;
  transition: Transition;
}

export type MissionTransitionEnvelope = TransitionEnvelope<
  "mission",
  StatusTransition<MissionStatus> & { missionId: MissionId }
>;
export type WorkerTransitionEnvelope = TransitionEnvelope<
  "worker",
  StatusTransition<WorkerStatus> & { workerId: WorkerId; runId: RunId }
>;
export type RunTransitionEnvelope = TransitionEnvelope<
  "run",
  StatusTransition<RunStatus> & {
    runId: RunId;
    expectedLastEventSequence: number;
    attemptNumber?: number;
  }
>;

export type TransitionResult<Status extends string> =
  | {
      status: "applied";
      resultingStatus: Status;
      revision: Revision;
      appendedEventIds: readonly RunEventId[];
      replayed: boolean;
    }
  | { status: "rejected"; error: ContractError };

export type MissionTransitionResult = TransitionResult<MissionStatus>;
export type WorkerTransitionResult = TransitionResult<WorkerStatus>;
export type RunTransitionResult = TransitionResult<RunStatus>;

export type RunResultEnvelope =
  | {
      status: "terminal";
      runId: RunId;
      revision: Revision;
      lastEventId: RunEventId;
      result: RunResult;
    }
  | { status: "non-terminal"; runId: RunId; currentStatus: RunStatus }
  | { status: "error"; runId?: RunId; error: ContractError };

export interface ContractErrorEnvelope {
  status: "error";
  requestId?: string;
  runId?: RunId;
  eventId?: RunEventId;
  error: ContractError;
}

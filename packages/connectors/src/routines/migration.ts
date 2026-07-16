import type {
  AutomationRule,
  ScheduleEntry,
  ScheduledJob,
  SchedulerQueueEntry,
  WorkflowDefinition,
  WorkflowRun,
  Spine
} from "@fable/protocol";
import { validateScheduleTrigger } from "../scheduler/recurrence";
import { validateWorkflowDefinition } from "../workflows/definition";

type LegacySourceKind = Spine.ArtifactsAndRoutines.LegacySourceKind;
type LegacySourceProvenance = Spine.ArtifactsAndRoutines.LegacySourceProvenance;
type Routine = Spine.ArtifactsAndRoutines.Routine;
type RoutineVersion = Spine.ArtifactsAndRoutines.RoutineVersion;
type RoutineTrigger = Spine.ArtifactsAndRoutines.RoutineTrigger;
type RoutineOccurrenceReference = Spine.ArtifactsAndRoutines.RoutineOccurrenceReference;
type WorkspaceId = Spine.Primitives.WorkspaceId;
type ProjectId = Spine.Primitives.ProjectId;
type MemberId = Spine.Primitives.MemberId;
type InternalUserId = Spine.Primitives.InternalUserId;
type ProviderRouteId = Spine.Primitives.ProviderRouteId;
type RoutineId = Spine.Primitives.RoutineId;
type TriggerId = Spine.Primitives.TriggerId;
type RunId = Spine.Primitives.RunId;

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_SOURCES = 10_000;
const MAX_ID_CHARACTERS = 256;
const MAX_EVIDENCE_REFERENCE_CHARACTERS = 1_024;
const MAX_ROUTINE_TITLE_CHARACTERS = 1_024;
const MAX_ROUTINE_INSTRUCTION_CHARACTERS = 16_000;

export type LegacyRoutineMigrationReason =
  | "automation-shape-unsupported"
  | "bare-schedule-lacks-durable-action-and-timezone"
  | "deleted-source-retained"
  | "duplicate-source-identity"
  | "invalid-ownership-evidence"
  | "invalid-pinned-route-evidence"
  | "invalid-source"
  | "invalid-trigger"
  | "invalid-workflow-definition"
  | "missing-current-workflow-definition"
  | "missing-ownership-evidence"
  | "orphan-scheduler-queue-entry"
  | "orphan-workflow-run"
  | "paused-workflow-conflicts-with-active-job"
  | "scope-mismatch"
  | "source-checksum-mismatch"
  | "workflow-definition-version-ambiguous"
  | "workflow-ownership-mismatch";

export interface LegacyRoutineSourceReference {
  kind: LegacySourceKind;
  legacyId: string;
  legacySchemaVersion: number;
  checksum: string;
}

export interface LegacyRepositoryScope {
  workspaceId: string;
  projectId?: string;
}

export type LegacyOwnershipEvidence =
  | {
      status: "unresolved";
      reason: string;
    }
  | {
      status: "proven";
      source: LegacyRoutineSourceReference;
      workspaceId: string;
      projectId?: string;
      visibility: "member-private" | "workspace-shared";
      ownerMemberId?: string;
      createdByInternalUserId: string;
      evidenceReference: string;
    };

interface LegacySourceEnvelopeBase {
  legacyId: string;
  legacySchemaVersion: number;
  checksum: string;
  repositoryScope: LegacyRepositoryScope;
  ownership: LegacyOwnershipEvidence;
}

export type LegacyRoutineMigrationSource =
  | (LegacySourceEnvelopeBase & { kind: "automation-rule"; record: AutomationRule })
  | (LegacySourceEnvelopeBase & { kind: "schedule-entry"; record: ScheduleEntry })
  | (LegacySourceEnvelopeBase & { kind: "scheduled-job"; record: ScheduledJob })
  | (LegacySourceEnvelopeBase & {
      kind: "workflow-definition";
      record: WorkflowDefinition;
      /** The exact version selected by the frozen legacy snapshot. */
      selectedForSnapshot: boolean;
    })
  | (LegacySourceEnvelopeBase & { kind: "workflow-run"; record: WorkflowRun })
  | (LegacySourceEnvelopeBase & { kind: "scheduler-queue-entry"; record: SchedulerQueueEntry });

export interface LegacyPinnedRouteEvidence {
  source: LegacyRoutineSourceReference;
  workspaceId: string;
  backendId: string;
  modelId: string;
  providerRouteId: string;
  pinnedByInternalUserId: string;
  pinnedAt: string;
  reason: string;
  evidenceReference: string;
}

export interface LegacyRoutineMigrationInput {
  /** Injected once by the migration caller. The planner never reads the clock. */
  plannedAt: string;
  sources: readonly LegacyRoutineMigrationSource[];
  pinnedRouteEvidence?: readonly LegacyPinnedRouteEvidence[];
}

export type LegacyRoutineMigrationDisposition =
  | "candidate"
  | "supporting-provenance"
  | "supporting-history"
  | "driver-local"
  | "retained-compatibility"
  | "quarantined";

export interface LegacyRoutineMigrationClassification {
  source: LegacyRoutineSourceReference;
  disposition: LegacyRoutineMigrationDisposition;
  reason?: LegacyRoutineMigrationReason;
  canonicalRoutineId?: string;
  /** Closed, secret-free facts only. Never contains a legacy payload. */
  retainedFacts?: Readonly<Record<string, string | number | boolean>>;
}

export interface LegacyRoutineCandidate {
  routine: Routine;
  version: RoutineVersion;
  trigger: RoutineTrigger;
}

export interface LegacyRoutineMigrationPlan {
  plannedAt: string;
  candidates: readonly LegacyRoutineCandidate[];
  occurrences: readonly RoutineOccurrenceReference[];
  classifications: readonly LegacyRoutineMigrationClassification[];
}

export class LegacyRoutineMigrationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyRoutineMigrationInputError";
  }
}

interface ProvenOwnership extends Extract<LegacyOwnershipEvidence, { status: "proven" }> {}

function sourceReference(source: LegacyRoutineMigrationSource): LegacyRoutineSourceReference {
  return {
    kind: source.kind,
    legacyId: source.legacyId,
    legacySchemaVersion: source.legacySchemaVersion,
    checksum: source.checksum
  };
}

function sourceKey(source: Pick<LegacyRoutineMigrationSource, "kind" | "legacyId">): string {
  return `${source.kind}\u0000${source.legacyId}`;
}

function referenceKey(source: LegacyRoutineSourceReference): string {
  return `${source.kind}\u0000${source.legacyId}\u0000${source.legacySchemaVersion}\u0000${source.checksum}`;
}

function validBoundedText(value: unknown, max = MAX_ID_CHARACTERS): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function canonicalIso(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validPermissionProfile(value: unknown): boolean {
  return (
    value === undefined ||
    ["read-only", "trusted", "full-with-approvals"].includes(String(value))
  );
}

function validStringList(value: unknown, allowed?: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 128 &&
    new Set(value).size === value.length &&
    value.every((item) => validBoundedText(item) && (!allowed || allowed.includes(item)))
  );
}

function boundedJsonObject(value: unknown): boolean {
  if (!isObject(value)) return false;
  try {
    return JSON.stringify(value).length <= 65_536;
  } catch {
    return false;
  }
}

function validExecutionShape(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isObject(value) || !["pinned", "current-default"].includes(String(value.policy))) return false;
  return (
    typeof value.backendId === "string" &&
    typeof value.modelId === "string" &&
    ["read-only", "trusted-scope", "full-access"].includes(String(value.permissionMode)) &&
    validPermissionProfile(value.permissionProfile) &&
    (value.policy !== "pinned" ||
      (validBoundedText(value.backendId) && validBoundedText(value.modelId)))
  );
}

function validTriggerShape(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.kind === "once") return typeof value.at === "string";
  if (value.kind !== "recurring" || !isObject(value.rule)) return false;
  const rule = value.rule;
  return (
    ["daily", "weekly", "monthly"].includes(String(rule.frequency)) &&
    typeof rule.interval === "number" &&
    typeof rule.hour === "number" &&
    typeof rule.minute === "number" &&
    (rule.byWeekday === undefined ||
      (Array.isArray(rule.byWeekday) &&
        new Set(rule.byWeekday).size === rule.byWeekday.length &&
        rule.byWeekday.every((day) =>
          ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].includes(String(day))
        ))) &&
    (rule.byMonthDay === undefined || typeof rule.byMonthDay === "number") &&
    (rule.until === undefined || typeof rule.until === "string") &&
    (rule.timezone === undefined || typeof rule.timezone === "string")
  );
}

function validWorkflowStepShape(value: unknown): boolean {
  if (!isObject(value) || !validBoundedText(value.id)) return false;
  if (!validPermissionProfile(value.permissionProfile)) return false;
  if (value.kind === "prompt") {
    return (
      typeof value.prompt === "string" &&
      value.prompt.length <= MAX_ROUTINE_INSTRUCTION_CHARACTERS &&
      (value.requiresConnectors === undefined || validStringList(value.requiresConnectors))
    );
  }
  if (value.kind === "agent") {
    return (
      typeof value.prompt === "string" &&
      value.prompt.length <= MAX_ROUTINE_INSTRUCTION_CHARACTERS &&
      (value.requiresConnectors === undefined || validStringList(value.requiresConnectors)) &&
      (value.maxTurns === undefined ||
        (Number.isInteger(value.maxTurns) && Number(value.maxTurns) >= 1 && Number(value.maxTurns) <= 100))
    );
  }
  if (value.kind === "approval") {
    return (
      validBoundedText(value.description, MAX_ROUTINE_INSTRUCTION_CHARACTERS) &&
      (value.permissionProfile === undefined || typeof value.permissionProfile === "string")
    );
  }
  if (value.kind === "tool") {
    return (
      validBoundedText(value.tool) &&
      boundedJsonObject(value.arguments) &&
      typeof value.consequential === "boolean"
    );
  }
  if (value.kind === "connector-read") {
    return (
      validBoundedText(value.connectorId) &&
      validBoundedText(value.capability) &&
      boundedJsonObject(value.input) &&
      validBoundedText(value.outputVar)
    );
  }
  if (value.kind === "connector-write") {
    return (
      validBoundedText(value.connectorId) &&
      validBoundedText(value.capability) &&
      boundedJsonObject(value.input) &&
      validBoundedText(value.target, MAX_ROUTINE_INSTRUCTION_CHARACTERS) &&
      validBoundedText(value.preview, MAX_ROUTINE_INSTRUCTION_CHARACTERS) &&
      ["low", "medium", "high", "critical"].includes(String(value.riskLevel)) &&
      (value.outputVar === undefined || validBoundedText(value.outputVar))
    );
  }
  return false;
}

function validRecordShape(source: LegacyRoutineMigrationSource): boolean {
  const record: Record<string, unknown> = source.record as unknown as Record<string, unknown>;
  if (source.kind === "automation-rule") {
    return (
      typeof record.id === "string" &&
      typeof record.title === "string" &&
      typeof record.trigger === "string" &&
      typeof record.destination === "string" &&
      ["draft", "active", "paused"].includes(String(record.status)) &&
      typeof record.requiresApproval === "boolean"
    );
  }
  if (source.kind === "schedule-entry") {
    return (
      typeof record.id === "string" &&
      typeof record.name === "string" &&
      typeof record.description === "string" &&
      ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].includes(String(record.day)) &&
      typeof record.time === "string" &&
      typeof record.enabled === "boolean" &&
      typeof record.createdAt === "string"
    );
  }
  if (source.kind === "scheduled-job") {
    const execution = record.execution;
    return (
      typeof record.id === "string" &&
      typeof record.schemaVersion === "number" &&
      typeof record.name === "string" &&
      typeof record.description === "string" &&
      typeof record.workflowDefinitionId === "string" &&
      validTriggerShape(record.trigger) &&
      ["skip", "run-once", "run-all"].includes(String(record.missedRunPolicy)) &&
      ["active", "paused", "deleted"].includes(String(record.status)) &&
      typeof record.nextRunAt === "string" &&
      typeof record.lastRunAt === "string" &&
      typeof record.lastRunId === "string" &&
      typeof record.createdAt === "string" &&
      typeof record.updatedAt === "string" &&
      (record.workspaceId === undefined || typeof record.workspaceId === "string") &&
      (record.projectId === undefined || typeof record.projectId === "string") &&
      validExecutionShape(execution)
    );
  }
  if (source.kind === "workflow-definition") {
    return (
      typeof record.id === "string" &&
      typeof record.schemaVersion === "number" &&
      typeof record.version === "number" &&
      typeof record.name === "string" &&
      typeof record.description === "string" &&
      (record.status === undefined || ["active", "paused"].includes(String(record.status))) &&
      validPermissionProfile(record.permissionProfile) &&
      Array.isArray(record.steps) &&
      record.steps.every(validWorkflowStepShape) &&
      (record.notificationPrefs === undefined ||
        (isObject(record.notificationPrefs) &&
          typeof record.notificationPrefs.disableOs === "boolean" &&
          validStringList(record.notificationPrefs.enabledKinds, [
            "run-completed",
            "run-failed",
            "approval-needed"
          ]))) &&
      typeof record.createdAt === "string" &&
      typeof record.updatedAt === "string" &&
      typeof source.selectedForSnapshot === "boolean"
    );
  }
  if (source.kind === "workflow-run") {
    return (
      typeof record.id === "string" &&
      typeof record.definitionId === "string" &&
      typeof record.definitionVersion === "number" &&
      ["queued", "running", "awaiting-approval", "completed", "failed", "blocked-auth", "cancelled"].includes(
        String(record.status)
      ) &&
      ["schedule", "manual", "voice"].includes(String(record.trigger)) &&
      (record.scheduledJobId === undefined || typeof record.scheduledJobId === "string") &&
      isObject(record.input) &&
      Array.isArray(record.steps) &&
      typeof record.startedAt === "string" &&
      typeof record.updatedAt === "string" &&
      (record.finishedAt === undefined || typeof record.finishedAt === "string")
    );
  }
  return (
    typeof record.jobId === "string" &&
    typeof record.runId === "string" &&
    typeof record.scheduledAt === "string" &&
    ["queued", "leased", "running", "completed", "failed", "blocked-auth", "cancelled", "done", "dead"].includes(
      String(record.state)
    ) &&
    typeof record.leaseHolder === "string" &&
    typeof record.leaseExpiresAt === "string" &&
    Array.isArray(record.attempts) &&
    typeof record.deduplicationKey === "string" &&
    (record.workspaceId === undefined || typeof record.workspaceId === "string") &&
    (record.projectId === undefined || typeof record.projectId === "string")
  );
}

function workflowDefinitionErrors(definition: WorkflowDefinition): string[] {
  try {
    return validateWorkflowDefinition(definition);
  } catch {
    return ["Malformed workflow definition."];
  }
}

function scheduleTriggerError(trigger: ScheduledJob["trigger"]): string | null {
  try {
    return validateScheduleTrigger(trigger);
  } catch {
    return "Malformed schedule trigger.";
  }
}

function validSource(source: LegacyRoutineMigrationSource): boolean {
  if (
    !source ||
    typeof source !== "object" ||
    !["automation-rule", "schedule-entry", "scheduled-job", "workflow-definition", "workflow-run", "scheduler-queue-entry"].includes(
      source.kind
    ) ||
    !source.record ||
    typeof source.record !== "object" ||
    !source.repositoryScope ||
    typeof source.repositoryScope !== "object" ||
    !source.ownership ||
    typeof source.ownership !== "object" ||
    !["proven", "unresolved"].includes(source.ownership.status) ||
    (source.ownership.status === "proven" &&
      (!source.ownership.source || typeof source.ownership.source !== "object"))
  ) {
    return false;
  }
  if (
    !validBoundedText(source.legacyId) ||
    !Number.isInteger(source.legacySchemaVersion) ||
    source.legacySchemaVersion < 1 ||
    !SHA256_PATTERN.test(source.checksum) ||
    !validBoundedText(source.repositoryScope.workspaceId)
  ) {
    return false;
  }
  if (source.repositoryScope.projectId !== undefined && !validBoundedText(source.repositoryScope.projectId)) {
    return false;
  }
  if (!validRecordShape(source)) return false;
  if (source.kind === "scheduled-job" || source.kind === "automation-rule" || source.kind === "schedule-entry") {
    return source.record.id === source.legacyId;
  }
  if (source.kind === "workflow-run") return source.record.id === source.legacyId;
  return true;
}

function ownershipReason(source: LegacyRoutineMigrationSource): LegacyRoutineMigrationReason | null {
  const evidence = source.ownership;
  if (evidence.status === "unresolved") return "missing-ownership-evidence";
  if (referenceKey(evidence.source) !== referenceKey(sourceReference(source))) {
    return evidence.source.checksum === source.checksum
      ? "invalid-ownership-evidence"
      : "source-checksum-mismatch";
  }
  if (
    evidence.workspaceId !== source.repositoryScope.workspaceId ||
    evidence.projectId !== source.repositoryScope.projectId
  ) {
    return "scope-mismatch";
  }
  if (
    (evidence.visibility !== "member-private" && evidence.visibility !== "workspace-shared") ||
    !validBoundedText(evidence.createdByInternalUserId) ||
    !validBoundedText(evidence.evidenceReference, MAX_EVIDENCE_REFERENCE_CHARACTERS) ||
    (evidence.visibility === "member-private" && !validBoundedText(evidence.ownerMemberId)) ||
    (evidence.visibility === "workspace-shared" && evidence.ownerMemberId !== undefined)
  ) {
    return "invalid-ownership-evidence";
  }
  return null;
}

function provenOwnership(source: LegacyRoutineMigrationSource): ProvenOwnership | null {
  return ownershipReason(source) === null && source.ownership.status === "proven"
    ? source.ownership
    : null;
}

function recordScopeMatches(source: LegacyRoutineMigrationSource): boolean {
  if (source.kind !== "scheduled-job" && source.kind !== "scheduler-queue-entry") return true;
  const { record, repositoryScope } = source;
  return (
    (record.workspaceId === undefined || record.workspaceId === repositoryScope.workspaceId) &&
    (record.projectId === undefined || record.projectId === repositoryScope.projectId)
  );
}

function sameOwnership(left: ProvenOwnership, right: ProvenOwnership): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.visibility === right.visibility &&
    left.ownerMemberId === right.ownerMemberId &&
    left.createdByInternalUserId === right.createdByInternalUserId
  );
}

function provenance(
  source: LegacyRoutineMigrationSource,
  plannedAt: string,
  retainedFields?: Readonly<Record<string, unknown>>
): LegacySourceProvenance {
  return {
    kind: source.kind,
    legacyId: source.legacyId,
    legacySchemaVersion: source.legacySchemaVersion,
    importedAt: plannedAt,
    retainedFields: {
      sourceChecksum: source.checksum,
      ...(retainedFields ?? {})
    }
  };
}

function encodedId(value: string): string {
  return encodeURIComponent(value);
}

function routineIdFor(job: LegacyRoutineMigrationSource & { kind: "scheduled-job" }): RoutineId {
  return `routine:legacy-scheduled-job:${encodedId(job.legacyId)}` as RoutineId;
}

function triggerIdFor(job: LegacyRoutineMigrationSource & { kind: "scheduled-job" }): TriggerId {
  return `trigger:legacy-scheduled-job:${encodedId(job.legacyId)}` as TriggerId;
}

function classification(
  source: LegacyRoutineMigrationSource,
  disposition: LegacyRoutineMigrationDisposition,
  options: {
    reason?: LegacyRoutineMigrationReason;
    canonicalRoutineId?: string;
    retainedFacts?: Readonly<Record<string, string | number | boolean>>;
  } = {}
): LegacyRoutineMigrationClassification {
  return { source: sourceReference(source), disposition, ...options };
}

function recurringExpression(job: ScheduledJob): string {
  if (job.trigger.kind !== "recurring") throw new Error("Expected a recurring trigger.");
  const rule = job.trigger.rule;
  return `legacy-rrule-lite:v1:${JSON.stringify({
    frequency: rule.frequency,
    interval: rule.interval,
    byWeekday: rule.byWeekday ?? [],
    byMonthDay: rule.byMonthDay ?? null,
    hour: rule.hour,
    minute: rule.minute
  })}`;
}

function canonicalRoutePolicy(
  jobSource: LegacyRoutineMigrationSource & { kind: "scheduled-job" },
  evidence: readonly LegacyPinnedRouteEvidence[]
): Spine.ArtifactsAndRoutines.RoutineRoutePolicy | LegacyRoutineMigrationReason {
  const execution = jobSource.record.execution;
  if (!execution || execution.policy === "current-default") return { kind: "resolve-at-run" };
  const ref = sourceReference(jobSource);
  const matches = evidence.filter(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      candidate.source !== null &&
      typeof candidate.source === "object" &&
      referenceKey(candidate.source) === referenceKey(ref) &&
      candidate.workspaceId === jobSource.repositoryScope.workspaceId &&
      candidate.backendId === execution.backendId &&
      candidate.modelId === execution.modelId
  );
  if (matches.length !== 1) return "invalid-pinned-route-evidence";
  const match = matches[0]!;
  const pinnedAt = canonicalIso(match.pinnedAt);
  if (
    !validBoundedText(match.providerRouteId) ||
    !validBoundedText(match.pinnedByInternalUserId) ||
    !pinnedAt ||
    !validBoundedText(match.reason, 1_024) ||
    !validBoundedText(match.evidenceReference, MAX_EVIDENCE_REFERENCE_CHARACTERS)
  ) {
    return "invalid-pinned-route-evidence";
  }
  return {
    kind: "deliberate-pin",
    providerRouteId: match.providerRouteId as ProviderRouteId,
    pinnedByInternalUserId: match.pinnedByInternalUserId as InternalUserId,
    pinnedAt,
    reason: match.reason
  };
}

function buildCandidate(
  jobSource: LegacyRoutineMigrationSource & { kind: "scheduled-job" },
  definitionSource: LegacyRoutineMigrationSource & { kind: "workflow-definition" },
  owner: ProvenOwnership,
  plannedAt: string,
  routePolicy: Spine.ArtifactsAndRoutines.RoutineRoutePolicy
): LegacyRoutineCandidate {
  const job = jobSource.record;
  const definition = definitionSource.record;
  const routineId = routineIdFor(jobSource);
  const triggerId = triggerIdFor(jobSource);
  const createdAt = canonicalIso(job.createdAt)!;
  const updatedAt = canonicalIso(job.updatedAt)!;
  const status = job.status;
  const recordScope =
    owner.visibility === "member-private"
      ? { visibility: "member-private" as const, ownerMemberId: owner.ownerMemberId as MemberId }
      : { visibility: "workspace-shared" as const };
  const projectScope = owner.projectId ? { projectId: owner.projectId as ProjectId } : {};
  const jobProvenance = provenance(jobSource, plannedAt, {
    workflowDefinitionId: definition.id,
    workflowDefinitionVersion: definition.version,
    ...(job.trigger.kind === "recurring" && !job.trigger.rule.timezone
      ? { legacyTimezoneDefault: "UTC" }
      : {})
  });
  const definitionProvenance = provenance(definitionSource, plannedAt, {
    workflowDefinitionId: definition.id,
    workflowDefinitionVersion: definition.version
  });
  const commonMetadata = {
    workspaceId: owner.workspaceId as WorkspaceId,
    authority: "local" as const,
    schemaVersion: 1,
    revision: 1,
    createdByInternalUserId: owner.createdByInternalUserId as InternalUserId,
    createdAt,
    updatedAt,
    ...(status === "deleted" ? { deletedAt: updatedAt } : {}),
    ...recordScope
  };
  const triggerSpec: Spine.ArtifactsAndRoutines.RoutineTriggerSpec =
    job.trigger.kind === "once"
      ? { kind: "time-once", at: canonicalIso(job.trigger.at)!, timezone: "UTC" }
      : {
          kind: "time-recurring",
          timezone: job.trigger.rule.timezone ?? "UTC",
          recurrence: {
            frequency: job.trigger.rule.frequency,
            expression: recurringExpression(job),
            ...(job.trigger.rule.until ? { until: canonicalIso(job.trigger.rule.until)! } : {})
          },
          missedRunPolicy: job.missedRunPolicy
        };
  return {
    routine: {
      ...commonMetadata,
      id: routineId,
      status,
      title: job.name.trim(),
      currentVersion: 1,
      scope: projectScope,
      authorityPolicy: "no-expansion",
      legacySources: [jobProvenance, definitionProvenance]
    },
    version: {
      routineId,
      version: 1,
      createdAt,
      createdByInternalUserId: owner.createdByInternalUserId as InternalUserId,
      action: {
        kind: "workflow-compatibility",
        title: definition.name.trim(),
        instruction:
          job.description.trim() || definition.description.trim() || definition.name.trim(),
        legacyWorkflowDefinitionId: definition.id,
        input: { legacyWorkflowDefinitionVersion: definition.version }
      },
      scope: projectScope,
      routePolicy,
      placementPolicy: { kind: "resolve-at-run" },
      budgets: { capabilityGrantIds: [] },
      triggerIds: [triggerId]
    },
    trigger: {
      ...commonMetadata,
      id: triggerId,
      routineId,
      status,
      spec: triggerSpec,
      deduplication: {
        strategy: "per-trigger-event",
        keyTemplate: `legacy-scheduled-job:${encodedId(jobSource.legacyId)}:{scheduledFor}`
      },
      legacySources: [jobProvenance]
    }
  };
}

function queueIsPortableHistory(state: SchedulerQueueEntry["state"]): boolean {
  return ["completed", "failed", "blocked-auth", "cancelled", "done", "dead"].includes(state);
}

function validWorkflowRunForJob(
  source: LegacyRoutineMigrationSource & { kind: "workflow-run" },
  jobSource: LegacyRoutineMigrationSource & { kind: "scheduled-job" },
  definitionVersion: number
): boolean {
  const run = source.record;
  return (
    ownershipReason(source) === null &&
    sameOwnership(provenOwnership(source)!, provenOwnership(jobSource)!) &&
    run.trigger === "schedule" &&
    run.scheduledJobId === jobSource.record.id &&
    run.definitionId === jobSource.record.workflowDefinitionId &&
    run.definitionVersion === definitionVersion &&
    validBoundedText(run.id) &&
    canonicalIso(run.startedAt) !== null &&
    canonicalIso(run.updatedAt) !== null &&
    (run.finishedAt === undefined || canonicalIso(run.finishedAt) !== null)
  );
}

function occurrenceStatus(
  state: SchedulerQueueEntry["state"]
): Spine.ArtifactsAndRoutines.RoutineOccurrenceStatus {
  if (state === "completed" || state === "done") return "completed";
  if (state === "cancelled") return "cancelled";
  if (state === "blocked-auth") return "blocked";
  return "failed";
}

function occurrenceFromQueue(
  source: LegacyRoutineMigrationSource & { kind: "scheduler-queue-entry" },
  jobSource: LegacyRoutineMigrationSource & { kind: "scheduled-job" },
  runSource: (LegacyRoutineMigrationSource & { kind: "workflow-run" }) | undefined,
  plannedAt: string
): RoutineOccurrenceReference | null {
  const scheduledFor = canonicalIso(source.record.scheduledAt);
  if (!scheduledFor || !validBoundedText(source.record.deduplicationKey, 1_024)) return null;
  const expectedAttemptStatus =
    source.record.state === "completed" || source.record.state === "done"
      ? "succeeded"
      : source.record.state === "cancelled"
        ? "cancelled"
        : source.record.state === "blocked-auth"
          ? "blocked-auth"
          : "failed";
  const expectedRunStatus =
    source.record.state === "completed" || source.record.state === "done"
      ? "completed"
      : source.record.state === "cancelled"
        ? "cancelled"
        : source.record.state === "blocked-auth"
          ? "blocked-auth"
          : "failed";
  const latestFinishedAttempt = [...source.record.attempts]
    .reverse()
    .find(
      (attempt) =>
        attempt !== null &&
        typeof attempt === "object" &&
        typeof attempt.finishedAt === "string" &&
        canonicalIso(attempt.finishedAt)
    );
  if (latestFinishedAttempt && latestFinishedAttempt.status !== expectedAttemptStatus) return null;
  const completedAt =
    (latestFinishedAttempt?.finishedAt && canonicalIso(latestFinishedAttempt.finishedAt)) ||
    (runSource?.record.status === expectedRunStatus &&
      runSource.record.finishedAt &&
      canonicalIso(runSource.record.finishedAt));
  if (!completedAt) return null;
  const observedAt = completedAt;
  const status = occurrenceStatus(source.record.state);
  const resultStatus =
    status === "completed"
      ? "succeeded"
      : status === "cancelled"
        ? "cancelled"
        : status === "blocked"
          ? "blocked"
          : "failed";
  return {
    id: `occurrence:legacy-queue:${encodedId(source.legacyId)}`,
    routineId: routineIdFor(jobSource),
    triggerId: triggerIdFor(jobSource),
    routineVersion: 1,
    status,
    scheduledFor,
    observedAt,
    deduplicationKey: source.record.deduplicationKey,
    ...(validBoundedText(source.record.runId) ? { runId: source.record.runId as RunId } : {}),
    result: {
      status: resultStatus,
      completedAt,
      ...(resultStatus === "failed"
        ? { error: { code: "invalid", message: "Legacy scheduled occurrence failed.", retryable: false } }
        : {})
    },
    legacySources: [
      provenance(source, plannedAt, { state: source.record.state }),
      ...(runSource
        ? [
            provenance(runSource, plannedAt, {
              definitionId: runSource.record.definitionId,
              definitionVersion: runSource.record.definitionVersion,
              status: runSource.record.status
            })
          ]
        : [])
    ]
  };
}

function compareClassifications(
  left: LegacyRoutineMigrationClassification,
  right: LegacyRoutineMigrationClassification
): number {
  return (
    referenceKey(left.source).localeCompare(referenceKey(right.source)) ||
    left.disposition.localeCompare(right.disposition) ||
    (left.reason ?? "").localeCompare(right.reason ?? "")
  );
}

/**
 * Plans a reversible migration without mutating legacy or canonical storage.
 * Ambiguity is represented as quarantine, never repaired from ambient session
 * state. Queue lease/fencing data and workflow payloads are deliberately absent.
 */
export function planLegacyRoutineMigration(input: LegacyRoutineMigrationInput): LegacyRoutineMigrationPlan {
  if (!input || typeof input !== "object") {
    throw new LegacyRoutineMigrationInputError("A migration input object is required.");
  }
  const plannedAt = canonicalIso(input.plannedAt);
  if (!plannedAt) throw new LegacyRoutineMigrationInputError("plannedAt must be a valid ISO timestamp.");
  if (!Array.isArray(input.sources) || input.sources.length > MAX_SOURCES) {
    throw new LegacyRoutineMigrationInputError(`sources must contain at most ${MAX_SOURCES} records.`);
  }
  if (input.pinnedRouteEvidence !== undefined && !Array.isArray(input.pinnedRouteEvidence)) {
    throw new LegacyRoutineMigrationInputError("pinnedRouteEvidence must be an array when supplied.");
  }
  if (input.pinnedRouteEvidence && input.pinnedRouteEvidence.length > MAX_SOURCES) {
    throw new LegacyRoutineMigrationInputError(
      `pinnedRouteEvidence must contain at most ${MAX_SOURCES} records.`
    );
  }

  const sources = [...input.sources];
  const routeEvidence = input.pinnedRouteEvidence ?? [];
  const classified = new Map<number, LegacyRoutineMigrationClassification>();
  const candidates: LegacyRoutineCandidate[] = [];
  const occurrences: RoutineOccurrenceReference[] = [];
  const candidateJobs = new Map<string, LegacyRoutineMigrationSource & { kind: "scheduled-job" }>();
  const candidateDefinitionVersions = new Map<string, number>();

  const duplicateKeys = new Set<string>();
  const counts = new Map<string, number>();
  for (const [index, source] of sources.entries()) {
    if (
      !source ||
      typeof source !== "object" ||
      typeof source.kind !== "string" ||
      typeof source.legacyId !== "string" ||
      typeof source.legacySchemaVersion !== "number" ||
      typeof source.checksum !== "string"
    ) {
      throw new LegacyRoutineMigrationInputError(`sources[${index}] has no classifiable source reference.`);
    }
    const key = sourceKey(source);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of counts) if (count > 1) duplicateKeys.add(key);

  for (const [index, source] of sources.entries()) {
    if (!validSource(source)) {
      classified.set(index, classification(source, "quarantined", { reason: "invalid-source" }));
    } else if (duplicateKeys.has(sourceKey(source))) {
      classified.set(index, classification(source, "quarantined", { reason: "duplicate-source-identity" }));
    }
  }

  const definitions = sources
    .map((source, index) => ({ source, index }))
    .filter(
      (item): item is { source: LegacyRoutineMigrationSource & { kind: "workflow-definition" }; index: number } =>
        item.source.kind === "workflow-definition"
    );

  for (const [jobIndex, untypedJobSource] of sources.entries()) {
    if (untypedJobSource.kind !== "scheduled-job" || classified.has(jobIndex)) continue;
    const jobSource = untypedJobSource;
    const ownershipFailure = ownershipReason(jobSource);
    if (ownershipFailure) {
      classified.set(jobIndex, classification(jobSource, "quarantined", { reason: ownershipFailure }));
      continue;
    }
    if (!recordScopeMatches(jobSource)) {
      classified.set(jobIndex, classification(jobSource, "quarantined", { reason: "scope-mismatch" }));
      continue;
    }
    const job = jobSource.record;
    if (
      !validBoundedText(job.name, 1_024) ||
      job.description.length > MAX_ROUTINE_INSTRUCTION_CHARACTERS ||
      !validBoundedText(job.workflowDefinitionId) ||
      job.schemaVersion !== jobSource.legacySchemaVersion ||
      !canonicalIso(job.createdAt) ||
      !canonicalIso(job.updatedAt) ||
      (job.trigger.kind === "recurring" && job.trigger.rule.until !== undefined && !canonicalIso(job.trigger.rule.until))
    ) {
      classified.set(jobIndex, classification(jobSource, "quarantined", { reason: "invalid-source" }));
      continue;
    }
    if (scheduleTriggerError(job.trigger)) {
      classified.set(jobIndex, classification(jobSource, "quarantined", { reason: "invalid-trigger" }));
      continue;
    }
    const selected = definitions.filter(
      ({ source, index }) =>
        classified.get(index)?.disposition !== "quarantined" &&
        source.record.id === job.workflowDefinitionId &&
        source.selectedForSnapshot
    );
    if (selected.length === 0) {
      classified.set(
        jobIndex,
        classification(jobSource, "quarantined", { reason: "missing-current-workflow-definition" })
      );
      continue;
    }
    if (selected.length !== 1) {
      classified.set(
        jobIndex,
        classification(jobSource, "quarantined", { reason: "workflow-definition-version-ambiguous" })
      );
      for (const { source, index } of selected) {
        classified.set(
          index,
          classification(source, "quarantined", { reason: "workflow-definition-version-ambiguous" })
        );
      }
      continue;
    }
    const { source: definitionSource, index: definitionIndex } = selected[0]!;
    const definitionOwnershipFailure = ownershipReason(definitionSource);
    if (definitionOwnershipFailure) {
      classified.set(
        definitionIndex,
        classification(definitionSource, "quarantined", { reason: definitionOwnershipFailure })
      );
      classified.set(jobIndex, classification(jobSource, "quarantined", { reason: "workflow-ownership-mismatch" }));
      continue;
    }
    if (
      definitionSource.record.schemaVersion !== definitionSource.legacySchemaVersion ||
      !validBoundedText(definitionSource.record.name, MAX_ROUTINE_TITLE_CHARACTERS) ||
      definitionSource.record.description.length > MAX_ROUTINE_INSTRUCTION_CHARACTERS ||
      workflowDefinitionErrors(definitionSource.record).length > 0 ||
      !canonicalIso(definitionSource.record.createdAt) ||
      !canonicalIso(definitionSource.record.updatedAt)
    ) {
      classified.set(
        definitionIndex,
        classification(definitionSource, "quarantined", { reason: "invalid-workflow-definition" })
      );
      classified.set(jobIndex, classification(jobSource, "quarantined", { reason: "invalid-workflow-definition" }));
      continue;
    }
    const jobOwner = provenOwnership(jobSource)!;
    const definitionOwner = provenOwnership(definitionSource)!;
    if (!sameOwnership(jobOwner, definitionOwner)) {
      classified.set(jobIndex, classification(jobSource, "quarantined", { reason: "workflow-ownership-mismatch" }));
      continue;
    }
    if (job.status === "active" && definitionSource.record.status === "paused") {
      classified.set(
        jobIndex,
        classification(jobSource, "quarantined", { reason: "paused-workflow-conflicts-with-active-job" })
      );
      if (classified.get(definitionIndex)?.disposition !== "supporting-provenance") {
        classified.set(
          definitionIndex,
          classification(definitionSource, "retained-compatibility", {
            retainedFacts: { workflowDefinitionVersion: definitionSource.record.version }
          })
        );
      }
      continue;
    }
    const routePolicy = canonicalRoutePolicy(jobSource, routeEvidence);
    if (typeof routePolicy === "string") {
      classified.set(jobIndex, classification(jobSource, "quarantined", { reason: routePolicy }));
      continue;
    }
    const candidate = buildCandidate(jobSource, definitionSource, jobOwner, plannedAt, routePolicy);
    candidates.push(candidate);
    candidateJobs.set(job.id, jobSource);
    candidateDefinitionVersions.set(job.id, definitionSource.record.version);
    classified.set(
      jobIndex,
      classification(jobSource, "candidate", { canonicalRoutineId: candidate.routine.id })
    );
    classified.set(
      definitionIndex,
      classification(definitionSource, "supporting-provenance", {
        retainedFacts: { workflowDefinitionVersion: definitionSource.record.version }
      })
    );
  }

  for (const [index, source] of sources.entries()) {
    if (classified.has(index)) continue;
    const ownershipFailure = ownershipReason(source);
    if (ownershipFailure) {
      classified.set(index, classification(source, "quarantined", { reason: ownershipFailure }));
      continue;
    }
    if (!recordScopeMatches(source)) {
      classified.set(index, classification(source, "quarantined", { reason: "scope-mismatch" }));
      continue;
    }
    if (source.kind === "automation-rule") {
      classified.set(index, classification(source, "quarantined", { reason: "automation-shape-unsupported" }));
      continue;
    }
    if (source.kind === "schedule-entry") {
      const jobSource = candidateJobs.get(source.record.id);
      const owner = provenOwnership(source)!;
      if (jobSource && sameOwnership(owner, provenOwnership(jobSource)!)) {
        classified.set(
          index,
          classification(source, "supporting-provenance", {
            canonicalRoutineId: routineIdFor(jobSource),
            retainedFacts: { enabled: source.record.enabled }
          })
        );
      } else {
        classified.set(
          index,
          classification(source, "quarantined", { reason: "bare-schedule-lacks-durable-action-and-timezone" })
        );
      }
      continue;
    }
    if (source.kind === "workflow-definition") {
      const invalid =
        source.record.schemaVersion !== source.legacySchemaVersion ||
        workflowDefinitionErrors(source.record).length > 0 ||
        !canonicalIso(source.record.createdAt) ||
        !canonicalIso(source.record.updatedAt);
      classified.set(
        index,
        classification(source, invalid ? "quarantined" : "retained-compatibility", {
          ...(invalid ? { reason: "invalid-workflow-definition" as const } : {}),
          retainedFacts: { workflowDefinitionVersion: source.record.version }
        })
      );
      continue;
    }
    if (source.kind === "workflow-run") {
      const jobSource = source.record.scheduledJobId
        ? candidateJobs.get(source.record.scheduledJobId)
        : undefined;
      if (
        !jobSource ||
        !validWorkflowRunForJob(
          source,
          jobSource,
          candidateDefinitionVersions.get(jobSource.record.id)!
        )
      ) {
        classified.set(index, classification(source, "quarantined", { reason: "orphan-workflow-run" }));
      } else {
        classified.set(
          index,
          classification(source, "supporting-history", {
            canonicalRoutineId: routineIdFor(jobSource),
            retainedFacts: {
              definitionVersion: source.record.definitionVersion,
              status: source.record.status
            }
          })
        );
      }
      continue;
    }
    if (source.kind === "scheduler-queue-entry") {
      const jobSource = candidateJobs.get(source.record.jobId);
      if (
        !jobSource ||
        !sameOwnership(provenOwnership(source)!, provenOwnership(jobSource)!) ||
        !validBoundedText(source.record.jobId) ||
        !validBoundedText(source.record.runId) ||
        !validBoundedText(source.record.deduplicationKey, 1_024) ||
        !canonicalIso(source.record.scheduledAt)
      ) {
        classified.set(index, classification(source, "quarantined", { reason: "orphan-scheduler-queue-entry" }));
        continue;
      }
      if (!queueIsPortableHistory(source.record.state)) {
        classified.set(
          index,
          classification(source, "driver-local", {
            canonicalRoutineId: routineIdFor(jobSource),
            retainedFacts: {
              state: source.record.state,
              deduplicationKey: source.record.deduplicationKey
            }
          })
        );
        continue;
      }
      const runSource = sources.find(
        (candidate): candidate is LegacyRoutineMigrationSource & { kind: "workflow-run" } =>
          candidate.kind === "workflow-run" &&
          validSource(candidate) &&
          counts.get(sourceKey(candidate)) === 1 &&
          candidate.record.id === source.record.runId &&
          validWorkflowRunForJob(
            candidate,
            jobSource,
            candidateDefinitionVersions.get(jobSource.record.id)!
          )
      );
      const occurrence = occurrenceFromQueue(source, jobSource, runSource, plannedAt);
      if (!occurrence) {
        classified.set(index, classification(source, "quarantined", { reason: "invalid-source" }));
        continue;
      }
      occurrences.push(occurrence);
      classified.set(
        index,
        classification(source, "supporting-history", {
          canonicalRoutineId: routineIdFor(jobSource),
          retainedFacts: {
            state: source.record.state,
            deduplicationKey: source.record.deduplicationKey
          }
        })
      );
      continue;
    }
    // A valid scheduled job reaches this branch only when another source claimed
    // its definition. Retain it fail-closed rather than creating a partial routine.
    classified.set(index, classification(source, "quarantined", { reason: "missing-current-workflow-definition" }));
  }

  return {
    plannedAt,
    candidates: candidates.sort((left, right) => left.routine.id.localeCompare(right.routine.id)),
    occurrences: occurrences.sort((left, right) => left.id.localeCompare(right.id)),
    classifications: [...classified.values()].sort(compareClassifications)
  };
}

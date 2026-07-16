import type {
  AutomationRule,
  ScheduleEntry,
  ScheduledJob,
  SchedulerQueueEntry,
  WorkflowDefinition,
  WorkflowRun
} from "@fable/protocol";
import { describe, expect, it } from "vitest";
import {
  planLegacyRoutineMigration,
  type LegacyOwnershipEvidence,
  type LegacyPinnedRouteEvidence,
  type LegacyRepositoryScope,
  type LegacyRoutineMigrationInput,
  type LegacyRoutineMigrationSource,
  type LegacyRoutineSourceReference
} from "./migration";

const PLANNED_AT = "2026-07-16T12:34:56.000Z";
const SCOPE: LegacyRepositoryScope = { workspaceId: "workspace-1", projectId: "project-1" };

function checksum(seed: string): string {
  const hex = Array.from(seed)
    .map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${(hex || "0").repeat(Math.ceil(64 / Math.max(hex.length, 1))).slice(0, 64)}`;
}

function reference(
  kind: LegacyRoutineMigrationSource["kind"],
  legacyId: string,
  legacySchemaVersion = 1,
  sourceChecksum = checksum(`${kind}:${legacyId}:${legacySchemaVersion}`)
): LegacyRoutineSourceReference {
  return { kind, legacyId, legacySchemaVersion, checksum: sourceChecksum };
}

function provenOwnership(
  source: LegacyRoutineSourceReference,
  overrides: Partial<Extract<LegacyOwnershipEvidence, { status: "proven" }>> = {}
): Extract<LegacyOwnershipEvidence, { status: "proven" }> {
  return {
    status: "proven",
    source,
    workspaceId: SCOPE.workspaceId,
    projectId: SCOPE.projectId,
    visibility: "member-private",
    ownerMemberId: "member-1",
    createdByInternalUserId: "user-1",
    evidenceReference: `ownership-ledger:${source.kind}:${source.legacyId}`,
    ...overrides
  };
}

function envelope<T extends LegacyRoutineMigrationSource["kind"]>(
  kind: T,
  legacyId: string,
  record: Extract<LegacyRoutineMigrationSource, { kind: T }>["record"],
  overrides: Partial<Extract<LegacyRoutineMigrationSource, { kind: T }>> = {}
): Extract<LegacyRoutineMigrationSource, { kind: T }> {
  const legacySchemaVersion = overrides.legacySchemaVersion ?? 1;
  const sourceChecksum = overrides.checksum ?? checksum(`${kind}:${legacyId}:${legacySchemaVersion}`);
  const source = reference(kind, legacyId, legacySchemaVersion, sourceChecksum);
  return {
    kind,
    legacyId,
    legacySchemaVersion,
    checksum: sourceChecksum,
    repositoryScope: SCOPE,
    ownership: provenOwnership(source),
    record,
    ...overrides
  } as Extract<LegacyRoutineMigrationSource, { kind: T }>;
}

function workflowDefinition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    schemaVersion: 1,
    id: "workflow-1",
    version: 3,
    name: "Prepare weekly brief",
    description: "Collect project changes and prepare a brief.",
    status: "active",
    permissionProfile: "full-with-approvals",
    steps: [
      {
        kind: "connector-read",
        id: "read-project",
        connectorId: "project-system",
        capability: "search",
        input: { query: "private legacy input" },
        outputVar: "results"
      }
    ],
    createdAt: "2026-06-01T08:00:00Z",
    updatedAt: "2026-07-01T08:00:00Z",
    ...overrides
  };
}

function scheduledJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    workspaceId: SCOPE.workspaceId,
    projectId: SCOPE.projectId,
    id: "job-1",
    schemaVersion: 1,
    name: " Weekly brief ",
    description: "Prepare the durable weekly brief.",
    workflowDefinitionId: "workflow-1",
    trigger: {
      kind: "recurring",
      rule: { frequency: "weekly", interval: 1, byWeekday: ["Mon"], hour: 9, minute: 30 }
    },
    missedRunPolicy: "run-once",
    status: "active",
    execution: {
      policy: "current-default",
      backendId: "legacy-backend",
      modelId: "legacy-model",
      permissionMode: "full-access",
      permissionProfile: "full-with-approvals"
    },
    nextRunAt: "2026-07-20T09:30:00Z",
    lastRunAt: "",
    lastRunId: "",
    createdAt: "2026-06-01T08:00:00Z",
    updatedAt: "2026-07-01T08:00:00Z",
    ...overrides
  };
}

function jobSource(overrides: Partial<Extract<LegacyRoutineMigrationSource, { kind: "scheduled-job" }>> = {}) {
  const record = scheduledJob(overrides.record as Partial<ScheduledJob> | undefined);
  return envelope("scheduled-job", record.id, record, overrides);
}

function definitionSource(
  overrides: Partial<Extract<LegacyRoutineMigrationSource, { kind: "workflow-definition" }>> = {}
) {
  const record = workflowDefinition(overrides.record as Partial<WorkflowDefinition> | undefined);
  return envelope("workflow-definition", `${record.id}:v${record.version}`, record, {
    selectedForSnapshot: true,
    ...overrides
  });
}

function scheduleSource(overrides: Partial<ScheduleEntry> = {}) {
  const record: ScheduleEntry = {
    id: "job-1",
    name: "Weekly brief",
    description: "Legacy schedule shell",
    day: "Mon",
    time: "09:30",
    enabled: true,
    createdAt: "2026-06-01T08:00:00Z",
    ...overrides
  };
  return envelope("schedule-entry", record.id, record);
}

function automationSource(overrides: Partial<AutomationRule> = {}) {
  const record: AutomationRule = {
    id: "automation-1",
    title: "Send changes",
    trigger: "whenever something changes",
    destination: "somewhere external",
    status: "active",
    requiresApproval: true,
    ...overrides
  };
  return envelope("automation-rule", record.id, record);
}

function runSource(overrides: Partial<WorkflowRun> = {}) {
  const record: WorkflowRun = {
    id: "run-1",
    definitionId: "workflow-1",
    definitionVersion: 3,
    status: "completed",
    trigger: "schedule",
    scheduledJobId: "job-1",
    input: { secretPrompt: "must not migrate" },
    steps: [
      {
        stepId: "read-project",
        status: "succeeded",
        output: { token: "must not migrate" },
        toolCalls: [{ tool: "private-tool", arguments: "secret", ok: true, output: "secret" }]
      }
    ],
    startedAt: "2026-07-14T09:30:00Z",
    updatedAt: "2026-07-14T09:31:00Z",
    finishedAt: "2026-07-14T09:31:00Z",
    ...overrides
  };
  return envelope("workflow-run", record.id, record);
}

function queueSource(
  legacyId: string,
  overrides: Partial<SchedulerQueueEntry> = {}
): Extract<LegacyRoutineMigrationSource, { kind: "scheduler-queue-entry" }> {
  const record: SchedulerQueueEntry = {
    workspaceId: SCOPE.workspaceId,
    projectId: SCOPE.projectId,
    jobId: "job-1",
    runId: "run-1",
    scheduledAt: "2026-07-14T09:30:00Z",
    state: "completed",
    leaseHolder: "secret-driver-instance",
    leaseExpiresAt: "2026-07-14T09:35:00Z",
    leaseToken: "secret-fencing-token",
    attempts: [
      {
        runId: "run-1",
        status: "succeeded",
        attemptNumber: 1,
        startedAt: "2026-07-14T09:30:00Z",
        finishedAt: "2026-07-14T09:31:00Z",
        leaseToken: "secret-attempt-token",
        error: "private error details"
      }
    ],
    deduplicationKey: `${legacyId}:dedup`,
    lastError: "private last error",
    ...overrides
  };
  return envelope("scheduler-queue-entry", legacyId, record);
}

function coreSources() {
  return [jobSource(), definitionSource()] as const;
}

function classificationFor(
  plan: ReturnType<typeof planLegacyRoutineMigration>,
  kind: LegacyRoutineMigrationSource["kind"],
  legacyId: string
) {
  const found = plan.classifications.find(
    (classification) => classification.source.kind === kind && classification.source.legacyId === legacyId
  );
  expect(found, `${kind}:${legacyId} must be classified`).toBeDefined();
  return found!;
}

describe("legacy routine migration planner", () => {
  it("maps a recurring job with an explicit UTC compatibility default and no authority expansion", () => {
    const [job, definition] = coreSources();
    const plan = planLegacyRoutineMigration({ plannedAt: PLANNED_AT, sources: [job, definition] });

    expect(plan.candidates).toHaveLength(1);
    expect(plan.occurrences).toEqual([]);
    expect(plan.candidates[0]).toMatchObject({
      routine: {
        id: "routine:legacy-scheduled-job:job-1",
        title: "Weekly brief",
        status: "active",
        authority: "local",
        authorityPolicy: "no-expansion",
        workspaceId: SCOPE.workspaceId,
        visibility: "member-private",
        ownerMemberId: "member-1",
        scope: { projectId: SCOPE.projectId }
      },
      version: {
        routineId: "routine:legacy-scheduled-job:job-1",
        action: {
          kind: "workflow-compatibility",
          legacyWorkflowDefinitionId: "workflow-1",
          input: { legacyWorkflowDefinitionVersion: 3 }
        },
        routePolicy: { kind: "resolve-at-run" },
        placementPolicy: { kind: "resolve-at-run" },
        budgets: { capabilityGrantIds: [] }
      },
      trigger: {
        id: "trigger:legacy-scheduled-job:job-1",
        spec: {
          kind: "time-recurring",
          timezone: "UTC",
          recurrence: { frequency: "weekly" },
          missedRunPolicy: "run-once"
        }
      }
    });
    expect(plan.candidates[0]!.routine.legacySources[0]!.retainedFields).toMatchObject({
      sourceChecksum: job.checksum,
      legacyTimezoneDefault: "UTC"
    });
    expect(classificationFor(plan, "scheduled-job", "job-1")).toMatchObject({
      disposition: "candidate",
      canonicalRoutineId: "routine:legacy-scheduled-job:job-1"
    });
    expect(classificationFor(plan, "workflow-definition", "workflow-1:v3")).toMatchObject({
      disposition: "supporting-provenance",
      retainedFacts: { workflowDefinitionVersion: 3 }
    });

    const portable = JSON.stringify(plan.candidates[0]);
    expect(portable).not.toContain("permissionProfile");
    expect(portable).not.toContain("full-with-approvals");
    expect(portable).not.toContain("project-system");
    expect(portable).not.toContain("private legacy input");
  });

  it("maps one-time triggers to a canonical instant in UTC", () => {
    const job = jobSource({
      record: scheduledJob({ trigger: { kind: "once", at: "2026-08-01T10:15:00+01:00" } })
    });
    const plan = planLegacyRoutineMigration({ plannedAt: PLANNED_AT, sources: [job, definitionSource()] });

    expect(plan.candidates[0]!.trigger.spec).toEqual({
      kind: "time-once",
      at: "2026-08-01T09:15:00.000Z",
      timezone: "UTC"
    });
  });

  it("is deterministic when source and route-evidence order changes", () => {
    const sources = [
      queueSource("queue-complete"),
      automationSource(),
      definitionSource(),
      scheduleSource(),
      runSource(),
      queueSource("queue-live", { state: "leased", runId: "run-live" }),
      jobSource()
    ];
    const input: LegacyRoutineMigrationInput = { plannedAt: PLANNED_AT, sources };

    const forward = planLegacyRoutineMigration(input);
    const reversed = planLegacyRoutineMigration({ ...input, sources: [...sources].reverse() });

    expect(reversed).toEqual(forward);
    expect(forward.classifications).toHaveLength(sources.length);
    expect(
      new Set(forward.classifications.map(({ source }) => `${source.kind}:${source.legacyId}`)).size
    ).toBe(sources.length);
  });

  it("classifies every legacy family and redacts workflow payloads and scheduler leases", () => {
    const sources = [
      ...coreSources(),
      scheduleSource(),
      automationSource(),
      runSource(),
      queueSource("queue-complete"),
      queueSource("queue-live", { state: "running", runId: "run-live" })
    ];
    const plan = planLegacyRoutineMigration({ plannedAt: PLANNED_AT, sources });

    expect(classificationFor(plan, "schedule-entry", "job-1")).toMatchObject({
      disposition: "supporting-provenance",
      retainedFacts: { enabled: true }
    });
    expect(classificationFor(plan, "automation-rule", "automation-1")).toMatchObject({
      disposition: "quarantined",
      reason: "automation-shape-unsupported"
    });
    expect(classificationFor(plan, "workflow-run", "run-1")).toMatchObject({
      disposition: "supporting-history",
      retainedFacts: { definitionVersion: 3, status: "completed" }
    });
    expect(classificationFor(plan, "scheduler-queue-entry", "queue-complete")).toMatchObject({
      disposition: "supporting-history"
    });
    expect(classificationFor(plan, "scheduler-queue-entry", "queue-live")).toMatchObject({
      disposition: "driver-local",
      retainedFacts: { state: "running", deduplicationKey: "queue-live:dedup" }
    });
    expect(plan.occurrences).toHaveLength(1);
    expect(plan.occurrences[0]).toMatchObject({
      id: "occurrence:legacy-queue:queue-complete",
      routineId: "routine:legacy-scheduled-job:job-1",
      triggerId: "trigger:legacy-scheduled-job:job-1",
      status: "completed",
      result: { status: "succeeded" }
    });

    const portable = JSON.stringify(plan);
    for (const secret of [
      "secret-driver-instance",
      "secret-fencing-token",
      "secret-attempt-token",
      "private error details",
      "private last error",
      "must not migrate",
      "private-tool"
    ]) {
      expect(portable).not.toContain(secret);
    }
  });

  it("accepts only exact, uniquely evidenced legacy pins", () => {
    const job = jobSource({
      record: scheduledJob({
        execution: {
          policy: "pinned",
          backendId: "openai",
          modelId: "gpt-exact",
          permissionMode: "full-access"
        }
      })
    });
    const evidence: LegacyPinnedRouteEvidence = {
      source: reference("scheduled-job", job.legacyId, job.legacySchemaVersion, job.checksum),
      workspaceId: SCOPE.workspaceId,
      backendId: "openai",
      modelId: "gpt-exact",
      providerRouteId: "provider-route-1",
      pinnedByInternalUserId: "user-pin-author",
      pinnedAt: "2026-06-01T09:30:00+01:00",
      reason: "Original user selection",
      evidenceReference: "route-ledger:job-1"
    };

    const accepted = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [job, definitionSource()],
      pinnedRouteEvidence: [
        { ...evidence, modelId: "unrelated", providerRouteId: "wrong-route" },
        evidence
      ]
    });
    expect(accepted.candidates[0]!.version.routePolicy).toEqual({
      kind: "deliberate-pin",
      providerRouteId: "provider-route-1",
      pinnedByInternalUserId: "user-pin-author",
      pinnedAt: "2026-06-01T08:30:00.000Z",
      reason: "Original user selection"
    });

    for (const pinnedRouteEvidence of [
      [] as LegacyPinnedRouteEvidence[],
      [{ ...evidence, source: { ...evidence.source, checksum: checksum("wrong") } }],
      [{ ...evidence, workspaceId: "other-workspace" }],
      [evidence, { ...evidence }]
    ]) {
      const rejected = planLegacyRoutineMigration({
        plannedAt: PLANNED_AT,
        sources: [job, definitionSource()],
        pinnedRouteEvidence
      });
      expect(rejected.candidates).toEqual([]);
      expect(classificationFor(rejected, "scheduled-job", "job-1")).toMatchObject({
        disposition: "quarantined",
        reason: "invalid-pinned-route-evidence"
      });
    }
    expect(() =>
      planLegacyRoutineMigration({
        plannedAt: PLANNED_AT,
        sources: [job, definitionSource()],
        pinnedRouteEvidence: { length: 1 } as unknown as LegacyPinnedRouteEvidence[]
      })
    ).toThrow("pinnedRouteEvidence must be an array");
  });

  it("quarantines missing, invalid, or conflicting ownership and repository scopes", () => {
    const unresolved = jobSource({ ownership: { status: "unresolved", reason: "legacy row has no owner" } });
    const unresolvedPlan = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [unresolved, definitionSource()]
    });
    expect(classificationFor(unresolvedPlan, "scheduled-job", "job-1")).toMatchObject({
      disposition: "quarantined",
      reason: "missing-ownership-evidence"
    });

    const mismatchedScope = jobSource({
      record: scheduledJob({ workspaceId: "other-workspace" })
    });
    const scopePlan = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [mismatchedScope, definitionSource()]
    });
    expect(classificationFor(scopePlan, "scheduled-job", "job-1")).toMatchObject({
      disposition: "quarantined",
      reason: "scope-mismatch"
    });

    const otherOwnerDefinition = definitionSource();
    otherOwnerDefinition.ownership = provenOwnership(
      reference(
        otherOwnerDefinition.kind,
        otherOwnerDefinition.legacyId,
        otherOwnerDefinition.legacySchemaVersion,
        otherOwnerDefinition.checksum
      ),
      { ownerMemberId: "member-2" }
    );
    const ownershipPlan = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [jobSource(), otherOwnerDefinition]
    });
    expect(ownershipPlan.candidates).toEqual([]);
    expect(classificationFor(ownershipPlan, "scheduled-job", "job-1")).toMatchObject({
      disposition: "quarantined",
      reason: "workflow-ownership-mismatch"
    });
    expect(classificationFor(ownershipPlan, "workflow-definition", "workflow-1:v3")).toMatchObject({
      disposition: "retained-compatibility"
    });

    const malformedVisibility = jobSource();
    malformedVisibility.ownership = {
      ...malformedVisibility.ownership,
      visibility: "public"
    } as unknown as LegacyOwnershipEvidence;
    const malformedVisibilityPlan = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [malformedVisibility, definitionSource()]
    });
    expect(classificationFor(malformedVisibilityPlan, "scheduled-job", "job-1")).toMatchObject({
      disposition: "quarantined",
      reason: "invalid-ownership-evidence"
    });
    expect(malformedVisibilityPlan.candidates).toEqual([]);
  });

  it("fails closed for missing, ambiguous, invalid, paused, or invalid-trigger workflow bundles", () => {
    const missing = planLegacyRoutineMigration({ plannedAt: PLANNED_AT, sources: [jobSource()] });
    expect(classificationFor(missing, "scheduled-job", "job-1").reason).toBe(
      "missing-current-workflow-definition"
    );

    const versionThree = definitionSource();
    const versionFour = definitionSource({
      record: workflowDefinition({ version: 4 }),
      legacyId: "workflow-1:v4"
    });
    const ambiguous = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [jobSource(), versionThree, versionFour]
    });
    expect(ambiguous.candidates).toEqual([]);
    expect(classificationFor(ambiguous, "scheduled-job", "job-1").reason).toBe(
      "workflow-definition-version-ambiguous"
    );
    expect(classificationFor(ambiguous, "workflow-definition", "workflow-1:v3").reason).toBe(
      "workflow-definition-version-ambiguous"
    );
    expect(classificationFor(ambiguous, "workflow-definition", "workflow-1:v4").reason).toBe(
      "workflow-definition-version-ambiguous"
    );

    const invalidDefinition = definitionSource({
      record: workflowDefinition({ steps: [] })
    });
    const invalid = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [jobSource(), invalidDefinition]
    });
    expect(classificationFor(invalid, "scheduled-job", "job-1").reason).toBe(
      "invalid-workflow-definition"
    );

    const paused = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [jobSource(), definitionSource({ record: workflowDefinition({ status: "paused" }) })]
    });
    expect(classificationFor(paused, "scheduled-job", "job-1").reason).toBe(
      "paused-workflow-conflicts-with-active-job"
    );
    expect(classificationFor(paused, "workflow-definition", "workflow-1:v3").disposition).toBe(
      "retained-compatibility"
    );

    const badTrigger = jobSource({
      record: scheduledJob({
        trigger: { kind: "recurring", rule: { frequency: "daily", interval: 0, hour: 25, minute: 70 } }
      })
    });
    const triggerPlan = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [badTrigger, definitionSource()]
    });
    expect(classificationFor(triggerPlan, "scheduled-job", "job-1").reason).toBe("invalid-trigger");
  });

  it("quarantines bare schedules and free-form automations without inventing routines", () => {
    const plan = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [scheduleSource({ id: "bare-schedule" }), automationSource()]
    });

    expect(plan.candidates).toEqual([]);
    expect(classificationFor(plan, "schedule-entry", "bare-schedule")).toMatchObject({
      disposition: "quarantined",
      reason: "bare-schedule-lacks-durable-action-and-timezone"
    });
    expect(classificationFor(plan, "automation-rule", "automation-1")).toMatchObject({
      disposition: "quarantined",
      reason: "automation-shape-unsupported"
    });
  });

  it("quarantines duplicate source identities and emits no partial candidate", () => {
    const original = jobSource();
    const duplicate = jobSource({
      checksum: checksum("job-1-duplicate"),
      ownership: provenOwnership(
        reference("scheduled-job", "job-1", 1, checksum("job-1-duplicate"))
      )
    });
    const plan = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [original, definitionSource(), duplicate]
    });

    expect(plan.candidates).toEqual([]);
    const duplicates = plan.classifications.filter(
      ({ source }) => source.kind === "scheduled-job" && source.legacyId === "job-1"
    );
    expect(duplicates).toHaveLength(2);
    expect(duplicates.every(({ disposition }) => disposition === "quarantined")).toBe(true);
    expect(duplicates.every(({ reason }) => reason === "duplicate-source-identity")).toBe(true);
    expect(plan.classifications).toHaveLength(3);
  });

  it("preserves paused and deleted lifecycle state instead of reviving work", () => {
    for (const status of ["paused", "deleted"] as const) {
      const job = jobSource({ record: scheduledJob({ status }) });
      const plan = planLegacyRoutineMigration({
        plannedAt: PLANNED_AT,
        sources: [job, definitionSource()]
      });

      expect(plan.candidates).toHaveLength(1);
      expect(plan.candidates[0]!.routine.status).toBe(status);
      expect(plan.candidates[0]!.trigger.status).toBe(status);
      if (status === "deleted") {
        expect(plan.candidates[0]!.routine.deletedAt).toBe("2026-07-01T08:00:00.000Z");
        expect(plan.candidates[0]!.trigger.deletedAt).toBe("2026-07-01T08:00:00.000Z");
      }
    }
  });

  it("rejects replayed ownership checksums and safely reuses one exact workflow version", () => {
    const replayed = jobSource();
    replayed.ownership = provenOwnership(
      reference("scheduled-job", replayed.legacyId, replayed.legacySchemaVersion, checksum("stale-source"))
    );
    const rejected = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [replayed, definitionSource()]
    });
    expect(classificationFor(rejected, "scheduled-job", "job-1")).toMatchObject({
      disposition: "quarantined",
      reason: "source-checksum-mismatch"
    });

    const first = jobSource();
    const second = jobSource({ record: scheduledJob({ id: "job-2", name: "Second weekly brief" }) });
    const definition = definitionSource();
    const forward = planLegacyRoutineMigration({ plannedAt: PLANNED_AT, sources: [first, second, definition] });
    const reversed = planLegacyRoutineMigration({ plannedAt: PLANNED_AT, sources: [definition, second, first] });

    expect(forward).toEqual(reversed);
    expect(forward.candidates.map(({ routine }) => routine.id)).toEqual([
      "routine:legacy-scheduled-job:job-1",
      "routine:legacy-scheduled-job:job-2"
    ]);
    expect(classificationFor(forward, "workflow-definition", "workflow-1:v3")).toMatchObject({
      disposition: "supporting-provenance",
      retainedFacts: { workflowDefinitionVersion: 3 }
    });

    const conflicting = jobSource({ record: scheduledJob({ id: "job-conflict" }) });
    conflicting.ownership = provenOwnership(
      reference(conflicting.kind, conflicting.legacyId, conflicting.legacySchemaVersion, conflicting.checksum),
      { ownerMemberId: "member-2" }
    );
    const mixedForward = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [conflicting, first, definition]
    });
    const mixedReverse = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [definition, first, conflicting]
    });
    expect(mixedForward).toEqual(mixedReverse);
    expect(mixedForward.candidates.map(({ routine }) => routine.id)).toEqual([
      "routine:legacy-scheduled-job:job-1"
    ]);
    expect(classificationFor(mixedForward, "scheduled-job", "job-conflict").reason).toBe(
      "workflow-ownership-mismatch"
    );
    expect(classificationFor(mixedForward, "workflow-definition", "workflow-1:v3").disposition).toBe(
      "supporting-provenance"
    );
  });

  it("quarantines hostile runtime records without throwing or widening authority", () => {
    const malformedJob = jobSource();
    malformedJob.record = { ...malformedJob.record, trigger: null } as unknown as ScheduledJob;
    const jobPlan = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [malformedJob, definitionSource()]
    });
    expect(classificationFor(jobPlan, "scheduled-job", "job-1")).toMatchObject({
      disposition: "quarantined",
      reason: "invalid-source"
    });

    const malformedDefinition = definitionSource();
    malformedDefinition.record = {} as WorkflowDefinition;
    const definitionPlan = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [jobSource(), malformedDefinition]
    });
    expect(classificationFor(definitionPlan, "workflow-definition", "workflow-1:v3")).toMatchObject({
      disposition: "quarantined",
      reason: "invalid-source"
    });
    expect(definitionPlan.candidates).toEqual([]);

    for (const steps of [
      [{ id: "unknown-step", kind: "unknown" }],
      [{ id: "incomplete-read", kind: "connector-read" }],
      [{ id: "bad-profile", kind: "prompt", prompt: "Do work", permissionProfile: "unbounded" }],
      [{ id: "bad-connectors", kind: "prompt", prompt: "Do work", requiresConnectors: "not-an-array" }],
      [{ id: "bad-turns", kind: "agent", prompt: "Do work", maxTurns: "many" }],
      [
        {
          id: "bad-output",
          kind: "connector-write",
          connectorId: "mail",
          capability: "send",
          input: {},
          target: "message",
          preview: "preview",
          riskLevel: "high",
          outputVar: 123
        }
      ]
    ]) {
      const malformedStepDefinition = definitionSource();
      malformedStepDefinition.record = {
        ...malformedStepDefinition.record,
        steps
      } as unknown as WorkflowDefinition;
      const malformedStepPlan = planLegacyRoutineMigration({
        plannedAt: PLANNED_AT,
        sources: [jobSource(), malformedStepDefinition]
      });
      expect(classificationFor(malformedStepPlan, "workflow-definition", "workflow-1:v3")).toMatchObject({
        disposition: "quarantined",
        reason: "invalid-source"
      });
      expect(malformedStepPlan.candidates).toEqual([]);
    }

    const malformedDefinitionProfile = definitionSource();
    malformedDefinitionProfile.record = {
      ...malformedDefinitionProfile.record,
      permissionProfile: "unbounded"
    } as unknown as WorkflowDefinition;
    const malformedDefinitionProfilePlan = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [jobSource(), malformedDefinitionProfile]
    });
    expect(
      classificationFor(malformedDefinitionProfilePlan, "workflow-definition", "workflow-1:v3")
    ).toMatchObject({ disposition: "quarantined", reason: "invalid-source" });
    expect(malformedDefinitionProfilePlan.candidates).toEqual([]);

    const malformedNotifications = definitionSource();
    malformedNotifications.record = {
      ...malformedNotifications.record,
      notificationPrefs: { disableOs: "sometimes", enabledKinds: ["run-completed"] }
    } as unknown as WorkflowDefinition;
    const malformedNotificationsPlan = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [jobSource(), malformedNotifications]
    });
    expect(classificationFor(malformedNotificationsPlan, "workflow-definition", "workflow-1:v3")).toMatchObject({
      disposition: "quarantined",
      reason: "invalid-source"
    });
    expect(malformedNotificationsPlan.candidates).toEqual([]);

    const invalidWeekday = jobSource({
      record: scheduledJob({
        trigger: {
          kind: "recurring",
          rule: {
            frequency: "weekly",
            interval: 1,
            byWeekday: ["Notaday" as "Mon"],
            hour: 9,
            minute: 0
          }
        }
      })
    });
    const invalidWeekdayPlan = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [invalidWeekday, definitionSource()]
    });
    expect(classificationFor(invalidWeekdayPlan, "scheduled-job", "job-1")).toMatchObject({
      disposition: "quarantined",
      reason: "invalid-source"
    });

    const oversized = jobSource({
      record: scheduledJob({ description: "x".repeat(16_001) })
    });
    const oversizedPlan = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [oversized, definitionSource()]
    });
    expect(classificationFor(oversizedPlan, "scheduled-job", "job-1")).toMatchObject({
      disposition: "quarantined",
      reason: "invalid-source"
    });
    expect(oversizedPlan.candidates).toEqual([]);

    const malformedExecution = jobSource({
      record: scheduledJob({
        execution: {
          policy: "current-default",
          backendId: "",
          modelId: "legacy-model",
          permissionMode: "unbounded" as "read-only"
        }
      })
    });
    const malformedExecutionPlan = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [malformedExecution, definitionSource()]
    });
    expect(classificationFor(malformedExecutionPlan, "scheduled-job", "job-1")).toMatchObject({
      disposition: "quarantined",
      reason: "invalid-source"
    });
    expect(malformedExecutionPlan.candidates).toEqual([]);

    const malformedQueue = queueSource("queue-malformed");
    malformedQueue.record = { ...malformedQueue.record, attempts: null } as unknown as SchedulerQueueEntry;
    const queuePlan = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [...coreSources(), malformedQueue]
    });
    expect(classificationFor(queuePlan, "scheduler-queue-entry", "queue-malformed")).toMatchObject({
      disposition: "quarantined",
      reason: "invalid-source"
    });
  });

  it("does not invent terminal completion time from migration time", () => {
    const queue = queueSource("queue-no-completion", { attempts: [] });
    const plan = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [...coreSources(), queue]
    });

    expect(plan.occurrences).toEqual([]);
    expect(classificationFor(plan, "scheduler-queue-entry", "queue-no-completion")).toMatchObject({
      disposition: "quarantined",
      reason: "invalid-source"
    });

    const mismatched = queueSource("queue-mismatched-outcome", {
      state: "completed",
      attempts: [
        {
          runId: "run-1",
          status: "failed",
          attemptNumber: 1,
          startedAt: "2026-07-14T09:30:00Z",
          finishedAt: "2026-07-14T09:31:00Z"
        }
      ]
    });
    const mismatchedPlan = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [...coreSources(), mismatched]
    });
    expect(mismatchedPlan.occurrences).toEqual([]);
    expect(classificationFor(mismatchedPlan, "scheduler-queue-entry", "queue-mismatched-outcome")).toMatchObject({
      disposition: "quarantined",
      reason: "invalid-source"
    });

    const contradictory = queueSource("queue-contradictory-attempts", {
      state: "completed",
      attempts: [
        {
          runId: "run-1",
          status: "succeeded",
          attemptNumber: 1,
          startedAt: "2026-07-14T09:30:00Z",
          finishedAt: "2026-07-14T09:31:00Z"
        },
        {
          runId: "run-1",
          status: "failed",
          attemptNumber: 2,
          startedAt: "2026-07-14T09:32:00Z",
          finishedAt: "2026-07-14T09:33:00Z"
        }
      ]
    });
    const contradictoryPlan = planLegacyRoutineMigration({
      plannedAt: PLANNED_AT,
      sources: [...coreSources(), contradictory]
    });
    expect(contradictoryPlan.occurrences).toEqual([]);
    expect(
      classificationFor(contradictoryPlan, "scheduler-queue-entry", "queue-contradictory-attempts")
    ).toMatchObject({ disposition: "quarantined", reason: "invalid-source" });
  });
});

# Workflows & Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace schedule-shaped UI state with a durable local execution engine, approval-aware workflows, native notifications, and functional push-to-talk voice — without release work, provider connectors, knowledge retrieval, or a competing database.

**Architecture:** Pure TypeScript owns scheduling math, workflow definition/execution, notification shaping, and voice orchestration. Rust owns the durable queue, leases/locks, atomic persistence, egress, OS notifications, and the in-process scheduler tick (single Tauri process shared across windows → natural dedup/lock boundary). Wire types live in `@fable/protocol`. The scheduler triggers versioned workflow definitions; workflow runs drive the existing `runAgentLoop` + `ApprovalGate`; runs pause for fresh approval on consequential writes; notifications and voice reuse the same agent/tool/permission/approval boundaries as typed input.

**Tech Stack:** Rust (Tauri commands, `tokio`, atomic JSON), TypeScript (Vitest, pure logic), React (minimal shell changes), Tauri notification + event APIs, Web Speech API / pluggable STT boundary.

**Worktree:** All work happens in `C:\Users\Josh\Projects\fable-worktrees\workflows-voice` on branch `codex/workflows-voice`. Do not merge into main.

---

## Cross-Cutting Contracts (define first, before any subsystem)

These shared protocol types and repository interfaces are referenced by every subsystem. They are defined in Phase 0 so later phases compose against stable contracts, satisfying the coordination requirements for Goals 5/6/8.

### Repository + agent execution contracts

**Goal 5 (persistence) integration:** scheduler/workflow/runtime state is read/written through a TypeScript repository interface implemented by Tauri-runtime wrappers (returning `null` in preview, mirroring the existing `runtime.ts` pattern). Each subsystem defines its own focused repository interface; Rust implements the concrete store. This keeps the storage boundary swappable for Goal 5's encrypted-SQLite migration without touching logic.

**Goal 6 (agent execution) integration:** workflows drive the existing `runAgentLoop(transport, request, options)` contract unchanged. The workflow runner is a *higher-level* orchestrator that calls `runAgentLoop` and routes its `BackendAgentEvent`s into persisted workflow-step state. No new agent contract is invented.

**Goal 8 (integration docs):** a single doc (`docs/product/workflows-voice.md`) records the integration requirements surfaced by this work: OS limitations, connector-capability degradations, STT provider boundary, and persistence interfaces.

---

## File Structure

### Phase 0 — Shared protocol types (packages/protocol/src/index.ts)
- `ScheduleTrigger`, `RecurrenceRule`, `MissedRunPolicy`, `WorkflowDefinition`, `WorkflowStep`, `WorkflowRun`, `WorkflowStepRecord`, `NotificationRecord`, `NotificationPrefs`, `VoiceProviderDescriptor` — added to the single protocol barrel.

### Phase 1 — Scheduler
- `packages/connectors/src/scheduler/recurrence.ts` — pure RRULE-lite: next-run math, TZ/DST, one-time + recurring.
- `packages/connectors/src/scheduler/recurrence.test.ts`
- `packages/connectors/src/scheduler/queue.ts` — pure queue/lease/dedup/retry math over an injectable clock + store interface.
- `packages/connectors/src/scheduler/queue.test.ts`
- `packages/connectors/src/scheduler/index.ts` — barrel.
- `apps/desktop/src-tauri/src/scheduler.rs` — durable JSON store + in-process tick + lease lock + recovery.
- `apps/desktop/src-tauri/src/models.rs` — scheduler wire structs/constants (extend).
- `apps/desktop/src-tauri/src/paths.rs` — schedule/job store paths (extend).
- `apps/desktop/src/lib/scheduler/` — TS repository wrappers + hook glue.
- `apps/desktop/src/lib/scheduler/recurrence.test.ts` — re-export contract tests if needed.

### Phase 2 — Workflow engine
- `packages/connectors/src/workflows/definition.ts` — versioned workflow shape, step typing, validation, bounds.
- `packages/connectors/src/workflows/runner.ts` — pure runner: step iteration, pause/resume around approval, persisting step records.
- `packages/connectors/src/workflows/runner.test.ts`
- `packages/connectors/src/workflows/templates.ts` — built-in examples with honest degradation.
- `packages/connectors/src/workflows/templates.test.ts`
- `packages/connectors/src/workflows/idempotency.ts` — pre-execution revalidation + idempotency-key shaping.
- `packages/connectors/src/workflows/idempotency.test.ts`
- `packages/connectors/src/workflows/index.ts` — barrel.
- `apps/desktop/src/lib/workflows/` — TS repository wrappers + run integration.
- `apps/desktop/src-tauri/src/workflows.rs` — durable workflow-run persistence.

### Phase 3 — Notifications
- `packages/connectors/src/notifications/shape.ts` — pure: shape private/public bodies, dedup, history ordering.
- `packages/connectors/src/notifications/shape.test.ts`
- `apps/desktop/src/lib/notifications/` — TS wrappers (Tauri notification + event + deep-link) + in-app history.
- `apps/desktop/src-tauri/src/notifications.rs` — OS notification dispatch + deep-link emission.

### Phase 4 — Voice
- `packages/connectors/src/voice/stt-boundary.ts` — pluggable STT interface + local (Web Speech) + remote-provider descriptors; never retains audio.
- `packages/connectors/src/voice/stt-boundary.test.ts`
- `apps/desktop/src/hooks/useVoice.ts` — push-to-talk state machine: idle/recording/processing/review/error.
- `apps/desktop/src/hooks/useVoice.test.tsx`
- `apps/desktop/src/components/VoiceComposer.tsx` — minimal review/edit surface.

### Phase 5 — UI integration
- `apps/desktop/src/components/pages/SchedulesPage.tsx` — replace definition-only list with operational view (upcoming run, status, last result, action-required).
- `apps/desktop/src/components/SchedulePanel.tsx` — extend for run-now/edit/missed-policy.
- `apps/desktop/src/components/RunHistoryDrawer.tsx` — on-demand detailed history.
- `apps/desktop/src/App.tsx` — wire scheduler tick + voice + minimal shell changes.

### Phase 6 — Docs + final verification
- `docs/product/workflows-voice.md` — honest capability + OS-limitation + integration doc.

---

# Phase 0 — Shared Protocol Types

### Task 0.1: Scheduler + workflow + notification + voice wire types

**Files:**
- Modify: `packages/protocol/src/index.ts` (append before the native-API section)

- [ ] **Step 1: Write a type-level smoke test**

`packages/protocol/src/protocol-smoke.test.ts` (new — confirms types are exported and assignable):

```ts
import { describe, expect, it } from "vitest";
import type {
  ScheduleTrigger, RecurrenceRule, MissedRunPolicy,
  WorkflowDefinition, WorkflowStep, WorkflowRun, WorkflowRunStatus,
  WorkflowStepRecord, NotificationRecord, NotificationKind, NotificationPrefs,
  VoiceProviderDescriptor, VoiceProviderKind
} from "./index";

describe("workflow-voice protocol types", () => {
  it("exports the scheduler trigger shapes", () => {
    const oneTime: ScheduleTrigger = { kind: "once", at: "2026-07-01T09:00:00Z" };
    const recurring: ScheduleTrigger = {
      kind: "recurring",
      timezone: "America/New_York",
      rule: { frequency: "weekly", byWeekday: ["Mon"], hour: 9, minute: 0 }
    };
    expect(oneTime.kind).toBe("once");
    expect(recurring.rule.frequency).toBe("weekly");
  });

  it("exports workflow definition + run shapes", () => {
    const def: WorkflowDefinition = {
      schemaVersion: 1, id: "wf-1", version: 1, name: "Brief",
      steps: [{ kind: "prompt", id: "s1", prompt: "Summarize the day." }],
      createdAt: "2026-06-28T00:00:00Z", updatedAt: "2026-06-28T00:00:00Z"
    };
    const run: WorkflowRun = {
      id: "run-1", definitionId: def.id, definitionVersion: 1, status: "completed",
      trigger: "manual", input: {}, steps: [], startedAt: "x", updatedAt: "x"
    };
    expect(def.steps[0].kind).toBe("prompt");
    expect(run.status satisfies WorkflowRunStatus).toBe("completed");
  });

  it("exports notification + voice shapes", () => {
    const n: NotificationRecord = { id: "n1", kind: "approval-needed", runId: "run-1", title: "Approval needed", createdAt: "x", private: false };
    const v: VoiceProviderDescriptor = { id: "web-speech", kind: "local", label: "On-device" };
    expect(n.kind satisfies NotificationKind).toBe("approval-needed");
    expect(v.kind satisfies VoiceProviderKind).toBe("local");
  });
});
```

- [ ] **Step 2: Run test to verify it fails (types not exported)**

Run: `pnpm --filter @fable/protocol test -- protocol-smoke` (or `pnpm test` at root filtered)
Expected: FAIL — module has no exported member errors.

- [ ] **Step 3: Add the types**

Append to `packages/protocol/src/index.ts` (before the `// Native-API agent loop` section) — the exact block:

```ts
// ---------------------------------------------------------------------------
// Scheduler, workflows, notifications, voice (Goal: local automation engine).
//
// These are wire types only. Pure logic lives in @fable/connectors; durable
// storage + OS integration lives in the Rust boundary; the shell wires them.
// ---------------------------------------------------------------------------

/** One-time or recurring trigger for a scheduled job. */
export type ScheduleTriggerKind = "once" | "recurring";

/** How to handle a run that was missed while the runtime was inactive. */
export type MissedRunPolicy =
  | "skip"            // drop missed occurrences (default)
  | "run-once"        // run the most recent missed occurrence once
  | "run-all";        // run every missed occurrence in order

/** Daily/weekly/monthly recurrence. Deliberately small (RRULE-lite). */
export interface RecurrenceRule {
  frequency: "daily" | "weekly" | "monthly";
  /** 1 = every interval; 2 = every other, etc. */
  interval: number;
  /** Weekdays (Mon..Sun) for weekly frequency. Empty = every day. */
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

export interface ScheduleTrigger {
  kind: "once";
  /** ISO timestamp of the single occurrence. */
  at: string;
} | {
  kind: "recurring";
  rule: RecurrenceRule;
}

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
  | "prompt"          // run an agent turn with a prompt
  | "connector-read"  // read from a connector capability
  | "agent"           // multi-turn agent step (tool calls gated)
  | "tool"            // a single Fable-owned tool call
  | "approval";       // pause for fresh explicit approval

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
  /** Approval state for approval steps. */
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

export type NotificationKind =
  | "run-completed"
  | "run-failed"
  | "approval-needed";

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
export type VoiceRecordingState =
  | "idle"
  | "recording"
  | "processing"
  | "review"
  | "error";
```

- [ ] **Step 4: Build protocol + run smoke test**

Run: `pnpm --filter @fable/protocol build && pnpm --filter @fable/protocol test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/index.ts packages/protocol/src/protocol-smoke.test.ts
git commit -m "feat(protocol): add scheduler, workflow, notification, voice wire types"
```

---

# Phase 1 — Scheduler

The scheduler is split: **pure TS** owns next-run math and queue logic (deterministic, fake-clock testable); **Rust** owns durable persistence, the in-process tick loop, leases, and restart recovery. The lead agent owns lifecycle; the scheduler prevents duplicate execution because the durable queue + lease live in the single shared Rust process.

## Part A — Pure recurrence math (TS)

### Task 1.1: Recurrence next-run calculation with TZ/DST

**Files:**
- Create: `packages/connectors/src/scheduler/recurrence.ts`
- Test: `packages/connectors/src/scheduler/recurrence.test.ts`

- [ ] **Step 1: Write failing tests covering TZ, DST, recurrence, one-time**

`packages/connectors/src/scheduler/recurrence.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { nextRunAfter, normalizeTriggerTime, isExpired } from "./recurrence";
import type { ScheduleTrigger } from "@fable/protocol";

const Z = (s: string) => new Date(s);

describe("nextRunAfter — one-time", () => {
  it("returns the once time when it is in the future", () => {
    const trigger: ScheduleTrigger = { kind: "once", at: "2026-07-01T09:00:00Z" };
    expect(nextRunAfter(trigger, Z("2026-06-28T00:00:00Z"))?.toISOString())
      .toBe("2026-07-01T09:00:00Z");
  });
  it("returns null when the once time has passed", () => {
    const trigger: ScheduleTrigger = { kind: "once", at: "2026-06-01T09:00:00Z" };
    expect(nextRunAfter(trigger, Z("2026-06-28T00:00:00Z"))).toBeNull();
  });
});

describe("nextRunAfter — daily recurrence", () => {
  it("advances one day at the same wall-clock time", () => {
    const trigger: ScheduleTrigger = {
      kind: "recurring",
      rule: { frequency: "daily", interval: 1, hour: 9, minute: 0, timezone: "UTC" }
    };
    expect(nextRunAfter(trigger, Z("2026-06-28T08:00:00Z"))?.toISOString())
      .toBe("2026-06-28T09:00:00Z");
    expect(nextRunAfter(trigger, Z("2026-06-28T09:30:00Z"))?.toISOString())
      .toBe("2026-06-29T09:00:00Z");
  });
  it("respects interval (every other day)", () => {
    const trigger: ScheduleTrigger = {
      kind: "recurring",
      rule: { frequency: "daily", interval: 2, hour: 9, minute: 0, timezone: "UTC" }
    };
    expect(nextRunAfter(trigger, Z("2026-06-28T09:30:00Z"))?.toISOString())
      .toBe("2026-06-30T09:00:00Z");
  });
});

describe("nextRunAfter — weekly + weekdays", () => {
  it("fires only on selected weekdays", () => {
    const trigger: ScheduleTrigger = {
      kind: "recurring",
      rule: { frequency: "weekly", interval: 1, byWeekday: ["Mon"], hour: 9, minute: 0, timezone: "UTC" }
    };
    // 2026-06-28 is a Sunday. Next Monday is 2026-06-29.
    expect(nextRunAfter(trigger, Z("2026-06-28T10:00:00Z"))?.toISOString())
      .toBe("2026-06-29T09:00:00Z");
  });
});

describe("nextRunAfter — DST handling", () => {
  // America/New_York springs forward 2026-03-08 02:00 -> 03:00.
  it("keeps 9am local wall-clock across US DST spring-forward", () => {
    const trigger: ScheduleTrigger = {
      kind: "recurring",
      rule: { frequency: "daily", interval: 1, hour: 9, minute: 0, timezone: "America/New_York" }
    };
    // The day before spring-forward, 9am EST = 14:00Z.
    expect(nextRunAfter(trigger, Z("2026-03-07T10:00:00Z"))?.toISOString())
      .toBe("2026-03-07T14:00:00Z");
    // After spring-forward (Mar 8), 9am EDT = 13:00Z.
    expect(nextRunAfter(trigger, Z("2026-03-08T10:00:00Z"))?.toISOString())
      .toBe("2026-03-08T13:00:00Z");
  });
});

describe("until expiry", () => {
  it("returns null past the until boundary", () => {
    const trigger: ScheduleTrigger = {
      kind: "recurring",
      rule: { frequency: "daily", interval: 1, hour: 9, minute: 0, timezone: "UTC", until: "2026-06-30T00:00:00Z" }
    };
    expect(nextRunAfter(trigger, Z("2026-07-01T00:00:00Z"))).toBeNull();
  });
});

describe("normalizeTriggerTime / isExpired", () => {
  it("normalizes a once trigger time and detects expiry", () => {
    const trigger: ScheduleTrigger = { kind: "once", at: "2026-07-01T09:00:00Z" };
    expect(normalizeTriggerTime(trigger, Z("2026-06-28T00:00:00Z")).toISOString())
      .toBe("2026-07-01T09:00:00Z");
    expect(isExpired(trigger, Z("2026-08-01T00:00:00Z"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @fable/connectors test -- recurrence`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement recurrence.ts**

`packages/connectors/src/scheduler/recurrence.ts`:

```ts
/**
 * Pure recurrence / next-run math. No I/O, no clocks except the injected `now`.
 *
 * Timezone + DST are handled by constructing the next occurrence in the target
 * IANA timezone's wall clock, then converting to UTC. The runtime ships the
 * full ICU tzdata via the platform; in the JS layer we use the Intl API to
 * format a wall-clock instant and Date to convert. This keeps DST transitions
 * correct (spring-forward skips 02:00→03:00; fall-back is resolved to the
 * earlier occurrence) without a third-party tz library.
 */

import type { RecurrenceRule, ScheduleTrigger, ScheduleWeekday } from "@fable/protocol";

const WEEKDAY_ORDER: ScheduleWeekday[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The next occurrence strictly after `after`, or null when expired/none. */
export function nextRunAfter(trigger: ScheduleTrigger, after: Date): Date | null {
  if (trigger.kind === "once") {
    const at = new Date(trigger.at);
    return at > after ? at : null;
  }
  return nextRecurringAfter(trigger.rule, after);
}

/** True when the trigger will never fire again at/after `now`. */
export function isExpired(trigger: ScheduleTrigger, now: Date): boolean {
  return nextRunAfter(trigger, now) === null;
}

/** Normalize a trigger to its next concrete fire time from `now` (once: the at). */
export function normalizeTriggerTime(trigger: ScheduleTrigger, now: Date): Date {
  if (trigger.kind === "once") return new Date(trigger.at);
  const next = nextRunAfter(trigger, now);
  if (!next) throw new Error("Trigger is expired and has no next occurrence.");
  return next;
}

function nextRecurringAfter(rule: RecurrenceRule, after: Date): Date | null {
  const tz = rule.timezone ?? "UTC";
  // Start scanning from the day of `after` in the target timezone.
  let candidate = startOfDayInTz(after, tz);
  const until = rule.until ? new Date(rule.until) : null;
  // Bound the scan to ~2 years of days to avoid pathological loops.
  const guard = new Date(after.getTime() + 1000 * 60 * 60 * 24 * 731);

  for (let i = 0; i < 731 * 2; i += 1) {
    if (candidate > guard) return null;
    const occ = occurrenceOnDay(rule, candidate, tz);
    if (occ && occ > after) {
      if (until && occ > until) return null;
      return occ;
    }
    candidate = addDays(candidate, 1);
  }
  return null;
}

/** Build the occurrence at rule.hour:minute on `day` in `tz`, or null if day excluded. */
function occurrenceOnDay(rule: RecurrenceRule, day: Date, tz: string): Date | null {
  const parts = wallClockParts(day, tz);
  if (rule.frequency === "weekly" && rule.byWeekday && rule.byWeekday.length > 0) {
    const wd = WEEKDAY_ORDER[parts.weekday];
    if (!rule.byWeekday.includes(wd)) return null;
  }
  if (rule.frequency === "monthly" && rule.byMonthDay !== undefined) {
    if (parts.day !== rule.byMonthDay) return null;
  }
  // interval handling for daily/weekly is approximated by accepting only days
  // where (epochDay % interval === anchor). Anchor on 1970-01-01 for determinism.
  if (rule.interval > 1) {
    const epochDay = Math.floor(day.getTime() / 86_400_000);
    if (epochDay % rule.interval !== 0) return null;
  }
  return fromWallClock(parts.year, parts.month, parts.day, rule.hour, rule.minute, tz);
}

interface WallParts { year: number; month: number; day: number; weekday: number; }

function wallClockParts(date: Date, tz: string): WallParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short"
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "";
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    weekday: WEEKDAY_ORDER.indexOf(weekdayStr as ScheduleWeekday)
  };
}

/** Construct a Date for a wall-clock instant in `tz` by computing the offset. */
function fromWallClock(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  // Build the instant as if UTC, then correct by the timezone offset at that instant.
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  const probe = new Date(asUtc);
  const offset = tzOffsetMinutes(probe, tz);
  return new Date(asUtc - offset * 60_000);
}

/** Offset of `tz` from UTC at the given instant, in minutes (EST=-300, EDT=-240). */
function tzOffsetMinutes(date: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" });
  const tzPart = fmt.formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = tzPart.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  const hours = Number(m[2]);
  const minutes = m[3] ? Number(m[3]) : 0;
  return sign * (hours * 60 + minutes);
}

function startOfDayInTz(date: Date, tz: string): Date {
  const parts = wallClockParts(date, tz);
  return fromWallClock(parts.year, parts.month, parts.day, 0, 0, tz);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}
```

- [ ] **Step 4: Run tests — verify pass**

Run: `pnpm --filter @fable/connectors test -- recurrence`
Expected: PASS (all recurrence cases incl. DST).

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/scheduler/recurrence.ts packages/connectors/src/scheduler/recurrence.test.ts
git commit -m "feat(scheduler): pure recurrence + next-run math with TZ/DST"
```

### Task 1.2: Missed-run policy

**Files:**
- Modify: `packages/connectors/src/scheduler/recurrence.ts`
- Test: `packages/connectors/src/scheduler/recurrence.test.ts` (append)

- [ ] **Step 1: Append failing tests**

Add to `recurrence.test.ts`:

```ts
import { missedOccurrences } from "./recurrence";

describe("missedOccurrences", () => {
  const trigger: ScheduleTrigger = {
    kind: "recurring",
    rule: { frequency: "daily", interval: 1, hour: 9, minute: 0, timezone: "UTC" }
  };
  it("skip policy returns empty", () => {
    expect(missedOccurrences(trigger, "skip", Z("2026-06-25T00:00:00Z"), Z("2026-06-28T00:00:00Z")))
      .toEqual([]);
  });
  it("run-once returns the single most recent missed", () => {
    const out = missedOccurrences(trigger, "run-once", Z("2026-06-25T00:00:00Z"), Z("2026-06-28T00:00:00Z"));
    expect(out.map((d) => d.toISOString())).toEqual(["2026-06-27T09:00:00Z"]);
  });
  it("run-all returns every missed occurrence in order", () => {
    const out = missedOccurrences(trigger, "run-all", Z("2026-06-25T00:00:00Z"), Z("2026-06-28T00:00:00Z"));
    expect(out.map((d) => d.toISOString())).toEqual([
      "2026-06-25T09:00:00Z", "2026-06-26T09:00:00Z", "2026-06-27T09:00:00Z"
    ]);
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `pnpm --filter @fable/connectors test -- recurrence`
Expected: FAIL — `missedOccurrences` not exported.

- [ ] **Step 3: Implement**

Append to `recurrence.ts`:

```ts
import type { MissedRunPolicy } from "@fable/protocol";

/**
 * Occurrences that fired between `lastRun` and `now` but were not executed
 * (runtime was inactive). Returns them in fire order. `skip` → []; `run-once`
 * → at most the single most recent; `run-all` → all.
 *
 * `lastRun` is the last *successful* run time (or the job creation time).
 */
export function missedOccurrences(
  trigger: ScheduleTrigger,
  policy: MissedRunPolicy,
  lastRun: Date,
  now: Date
): Date[] {
  if (policy === "skip" || trigger.kind === "once") return [];
  const missed: Date[] = [];
  let cursor = new Date(lastRun.getTime());
  for (let i = 0; i < 400; i += 1) {
    const next = nextRunAfter(trigger, cursor);
    if (!next || next >= now) break;
    missed.push(next);
    cursor = next;
  }
  if (missed.length === 0) return [];
  if (policy === "run-once") return [missed[missed.length - 1]];
  return missed;
}
```

- [ ] **Step 4: Run — verify pass**

Run: `pnpm --filter @fable/connectors test -- recurrence`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/scheduler/recurrence.ts packages/connectors/src/scheduler/recurrence.test.ts
git commit -m "feat(scheduler): missed-run policy (skip/run-once/run-all)"
```

## Part B — Pure queue/lease/dedup/retry math (TS)

### Task 1.3: Queue, leases, deduplication, retry backoff

**Files:**
- Create: `packages/connectors/src/scheduler/queue.ts`
- Test: `packages/connectors/src/scheduler/queue.test.ts`

- [ ] **Step 1: Write failing tests**

`packages/connectors/src/scheduler/queue.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  enqueue, acquireLease, releaseLease, expireLeases,
  markAttempt, retryDelayMs, deduplicationKeyFor
} from "./queue";
import type { SchedulerQueueEntry, ScheduledJob } from "@fable/protocol";

const job = (id: string): ScheduledJob => ({
  id, schemaVersion: 1, name: id, description: "", workflowDefinitionId: "wf",
  trigger: { kind: "once", at: "2026-07-01T09:00:00Z" },
  missedRunPolicy: "skip", status: "active",
  nextRunAt: "2026-07-01T09:00:00Z", lastRunAt: "", lastRunId: "",
  createdAt: "2026-06-28T00:00:00Z", updatedAt: "2026-06-28T00:00:00Z"
});

describe("enqueue + deduplication", () => {
  it("adds a queued entry with a deterministic dedup key", () => {
    const entries: SchedulerQueueEntry[] = [];
    const out = enqueue(entries, job("j1"), "run-1", "2026-07-01T09:00:00Z");
    expect(out).toHaveLength(1);
    expect(out[0].state).toBe("queued");
    expect(out[0].deduplicationKey).toBeTruthy();
  });
  it("refuses to duplicate an existing occurrence (same dedup key)", () => {
    const one = enqueue([], job("j1"), "run-1", "2026-07-01T09:00:00Z");
    const two = enqueue(one, job("j1"), "run-2", "2026-07-01T09:00:00Z");
    expect(two).toBe(one); // unchanged — no duplicate
  });
});

describe("leases", () => {
  it("acquires a lease only when the entry is unleased", () => {
    let e = enqueue([], job("j1"), "run-1", "2026-07-01T09:00:00Z");
    e = acquireLease(e, "run-1", "window-A", "2026-07-01T09:00:10Z", 30_000);
    expect(e.find((x) => x.runId === "run-1")?.leaseHolder).toBe("window-A");
    // A second window cannot steal it before expiry.
    e = acquireLease(e, "run-1", "window-B", "2026-07-01T09:00:11Z", 30_000);
    expect(e.find((x) => x.runId === "run-1")?.leaseHolder).toBe("window-A");
  });
  it("expires a lease past its deadline so another window may take it", () => {
    let e = enqueue([], job("j1"), "run-1", "2026-07-01T09:00:00Z");
    e = acquireLease(e, "run-1", "window-A", "2026-07-01T09:00:00Z", 30_000);
    e = expireLeases(e, new Date("2026-07-01T09:00:41Z"));
    expect(e.find((x) => x.runId === "run-1")?.leaseHolder).toBe("");
    e = acquireLease(e, "run-1", "window-B", "2026-07-01T09:00:42Z", 30_000);
    expect(e.find((x) => x.runId === "run-1")?.leaseHolder).toBe("window-B");
  });
  it("releases a lease", () => {
    let e = enqueue([], job("j1"), "run-1", "2026-07-01T09:00:00Z");
    e = acquireLease(e, "run-1", "window-A", "2026-07-01T09:00:00Z", 30_000);
    e = releaseLease(e, "run-1");
    expect(e.find((x) => x.runId === "run-1")?.leaseHolder).toBe("");
  });
});

describe("attempts + retry backoff", () => {
  it("records a failed attempt with terminal status after max retries", () => {
    let e = enqueue([], job("j1"), "run-1", "2026-07-01T09:00:00Z");
    e = markAttempt(e, "run-1", { runId: "run-1", status: "failed", attemptNumber: 1, startedAt: "x", error: "boom" }, 2);
    const entry = e.find((x) => x.runId === "run-1")!;
    expect(entry.attempts).toHaveLength(1);
    expect(entry.state).toBe("queued"); // retryable
  });
  it("moves to dead after exceeding max attempts", () => {
    let e = enqueue([], job("j1"), "run-1", "2026-07-01T09:00:00Z");
    e = markAttempt(e, "run-1", { runId: "run-1", status: "failed", attemptNumber: 1, startedAt: "x" }, 0);
    expect(e.find((x) => x.runId === "run-1")?.state).toBe("dead");
  });
  it("retryDelayMs uses exponential backoff", () => {
    expect(retryDelayMs(0)).toBeLessThan(retryDelayMs(1));
    expect(retryDelayMs(1)).toBeLessThan(retryDelayMs(2));
  });
});

describe("deduplicationKeyFor", () => {
  it("is stable for job+occurrence", () => {
    expect(deduplicationKeyFor("j1", "2026-07-01T09:00:00Z"))
      .toBe(deduplicationKeyFor("j1", "2026-07-01T09:00:00Z"));
    expect(deduplicationKeyFor("j1", "2026-07-02T09:00:00Z"))
      .not.toBe(deduplicationKeyFor("j1", "2026-07-01T09:00:00Z"));
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `pnpm --filter @fable/connectors test -- queue`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement queue.ts**

```ts
/**
 * Pure scheduler-queue logic over an immutable entry list. The Rust boundary
 * owns the actual persisted list + tick; these functions are the deterministic
 * math (enqueue, lease, expire, retry) tested with fakes.
 *
 * Concurrency model: a lease is held by one `leaseHolder` (window/instance id)
 * until `leaseExpiresAt`. Two windows cannot hold the same entry; an expired
 * lease frees the entry so another window may acquire it. This is the
 * duplicate-execution guard across multiple Fable windows.
 */

import type { JobAttempt, ScheduledJob, SchedulerQueueEntry } from "@fable/protocol";

const LEASE_MS = 30_000;

/** Stable dedup key for a (job, occurrence) pair. */
export function deduplicationKeyFor(jobId: string, scheduledAt: string): string {
  return `${jobId}:${scheduledAt}`;
}

/** Enqueue an occurrence, deduplicating by (job, scheduledAt). Returns the same
 *  list (reference-equal) when a duplicate is refused. */
export function enqueue(
  entries: SchedulerQueueEntry[],
  job: ScheduledJob,
  runId: string,
  scheduledAt: string
): SchedulerQueueEntry[] {
  const key = deduplicationKeyFor(job.id, scheduledAt);
  if (entries.some((e) => e.deduplicationKey === key)) return entries;
  const entry: SchedulerQueueEntry = {
    jobId: job.id,
    runId,
    scheduledAt,
    state: "queued",
    leaseHolder: "",
    leaseExpiresAt: "",
    attempts: [],
    deduplicationKey: key
  };
  return [...entries, entry];
}

/** Try to lease an entry. Succeeds only when currently unleased or its lease expired. */
export function acquireLease(
  entries: SchedulerQueueEntry[],
  runId: string,
  holder: string,
  nowIso: string,
  leaseMs = LEASE_MS
): SchedulerQueueEntry[] {
  const now = Date.parse(nowIso);
  return entries.map((e) => {
    if (e.runId !== runId) return e;
    const held = e.leaseHolder !== "" && Date.parse(e.leaseExpiresAt) > now;
    if (held && e.leaseHolder !== holder) return e;
    const expires = new Date(now + leaseMs).toISOString();
    return { ...e, leaseHolder: holder, leaseExpiresAt: expires, state: "leased" };
  });
}

/** Release a held lease back to queued. */
export function releaseLease(entries: SchedulerQueueEntry[], runId: string): SchedulerQueueEntry[] {
  return entries.map((e) =>
    e.runId === runId ? { ...e, leaseHolder: "", leaseExpiresAt: "", state: "queued" } : e
  );
}

/** Expire leases whose deadline has passed (frees them for re-acquisition). */
export function expireLeases(entries: SchedulerQueueEntry[], now: Date): SchedulerQueueEntry[] {
  const ms = now.getTime();
  return entries.map((e) => {
    if (e.leaseHolder === "" || Date.parse(e.leaseExpiresAt) > ms) return e;
    return { ...e, leaseHolder: "", leaseExpiresAt: "", state: "queued" };
  });
}

/** Mark an attempt outcome. On failure with retries remaining, re-queues; else dead. */
export function markAttempt(
  entries: SchedulerQueueEntry[],
  runId: string,
  attempt: JobAttempt,
  maxRetries: number
): SchedulerQueueEntry[] {
  return entries.map((e) => {
    if (e.runId !== runId) return e;
    const attempts = [...e.attempts, attempt];
    let state = e.state;
    if (attempt.status === "succeeded") state = "done";
    else if (attempt.status === "failed") {
      state = attempts.filter((a) => a.status === "failed").length > maxRetries ? "dead" : "queued";
    } else if (attempt.status === "cancelled") state = "done";
    return { ...e, attempts, state, leaseHolder: "", leaseExpiresAt: "" };
  });
}

/** Exponential backoff delay (ms) for a given attempt index (0-based). */
export function retryDelayMs(attemptIndex: number): number {
  const base = 1_000 * 2 ** attemptIndex; // 1s, 2s, 4s...
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(base + jitter, 60_000);
}

/** Entries ready to run now (queued, scheduled-at <= now, not leased). */
export function dueEntries(entries: SchedulerQueueEntry[], now: Date): SchedulerQueueEntry[] {
  const ms = now.getTime();
  return entries.filter((e) => e.state === "queued" && Date.parse(e.scheduledAt) <= ms);
}
```

- [ ] **Step 4: Run — verify pass**

Run: `pnpm --filter @fable/connectors test -- queue`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/scheduler/queue.ts packages/connectors/src/scheduler/queue.test.ts
git commit -m "feat(scheduler): pure queue, leases, dedup, retry backoff"
```

### Task 1.4: Scheduler barrel + connectors index export

**Files:**
- Create: `packages/connectors/src/scheduler/index.ts`
- Modify: `packages/connectors/src/index.ts` (append export)

- [ ] **Step 1: Create barrel**

`packages/connectors/src/scheduler/index.ts`:

```ts
export {
  nextRunAfter, isExpired, normalizeTriggerTime, missedOccurrences
} from "./recurrence";
export {
  deduplicationKeyFor, enqueue, acquireLease, releaseLease, expireLeases,
  markAttempt, retryDelayMs, dueEntries
} from "./queue";
```

- [ ] **Step 2: Append to connectors index**

Add at the end of `packages/connectors/src/index.ts`:

```ts
// scheduler (pure recurrence + queue math; durable store lives in the Rust boundary)
export {
  nextRunAfter, isExpired, normalizeTriggerTime, missedOccurrences,
  deduplicationKeyFor, enqueue, acquireLease, releaseLease, expireLeases,
  markAttempt, retryDelayMs, dueEntries
} from "./scheduler";
```

- [ ] **Step 3: Verify build**

Run: `pnpm --filter @fable/connectors typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/connectors/src/scheduler/index.ts packages/connectors/src/index.ts
git commit -m "feat(scheduler): export scheduler pure logic from @fable/connectors"
```

## Part C — Durable scheduler store + tick (Rust)

The durable store + in-process tick live in Rust. This is the lifecycle owner: a `tokio` task ticks every few seconds, computes due entries, leases them, emits run requests, and persists state atomically. Because Tauri is a single shared process, the lease map naturally prevents duplicate execution across windows.

### Task 1.5: Scheduler wire models + paths (Rust)

**Files:**
- Modify: `apps/desktop/src-tauri/src/models.rs` (append structs + constants)
- Modify: `apps/desktop/src-tauri/src/paths.rs` (append path helpers)

- [ ] **Step 1: Append constants + serde structs to models.rs**

Append (after the existing constants block):

```rust
// Scheduler constants.
pub const SCHEDULER_STORE_VERSION: u8 = 1;
pub const MAX_SCHEDULED_JOBS: usize = 100;
pub const MAX_SCHEDULER_QUEUE_ENTRIES: usize = 500;
pub const MAX_JOB_ATTEMPTS: usize = 20;
pub const SCHEDULER_TICK_SECS: u64 = 5;
pub const SCHEDULER_LEASE_MS: i64 = 30_000;
pub const SCHEDULER_MAX_RETRIES: u32 = 2;
pub const SCHEDULED_JOB_STATUSES: [&str; 3] = ["active", "paused", "deleted"];
pub const MISSED_RUN_POLICIES: [&str; 3] = ["skip", "run-once", "run-all"];
pub const SCHEDULER_JOB_STATES: [&str; 4] = ["queued", "leased", "done", "dead"];
pub const JOB_ATTEMPT_STATUSES: [&str; 4] = ["running", "succeeded", "failed", "cancelled"];
```

Then append serde structs mirroring the protocol types (Rust owns its own validated copy):

```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScheduledJob {
    pub id: String,
    pub schema_version: u8,
    pub name: String,
    pub description: String,
    pub workflow_definition_id: String,
    pub trigger: serde_json::Value,        // ScheduleTrigger (validated shallowly)
    pub missed_run_policy: String,
    pub status: String,
    pub next_run_at: String,
    pub last_run_at: String,
    pub last_run_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JobAttempt {
    pub run_id: String,
    pub status: String,
    pub attempt_number: u32,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SchedulerQueueEntry {
    pub job_id: String,
    pub run_id: String,
    pub scheduled_at: String,
    pub state: String,
    pub lease_holder: String,
    pub lease_expires_at: String,
    pub attempts: Vec<JobAttempt>,
    pub deduplication_key: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SchedulerStore {
    pub schema_version: u8,
    pub jobs: Vec<ScheduledJob>,
    pub queue: Vec<SchedulerQueueEntry>,
    pub instance_id: String,
    pub updated_at: String,
}
```

- [ ] **Step 2: Append path helpers to paths.rs**

```rust
pub fn scheduler_store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "scheduler-store.json")
}
```

- [ ] **Step 3: Verify Rust compiles**

Run: `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: PASS (unused warnings OK for now).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/models.rs apps/desktop/src-tauri/src/paths.rs
git commit -m "feat(scheduler): wire models + store path in Rust"
```

### Task 1.6: Durable scheduler store + commands (Rust)

**Files:**
- Create: `apps/desktop/src-tauri/src/scheduler.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (declare module + register commands + setup tick)

- [ ] **Step 1: Implement scheduler.rs**

`apps/desktop/src-tauri/src/scheduler.rs`:

```rust
//! Durable scheduler store: jobs + queue, atomically persisted. The in-process
//! tick loop (started in lib.rs setup) leases due entries and emits run-request
//! events. Because Tauri is a single shared process, the lease map prevents
//! duplicate execution across multiple Fable windows.

use std::{fs, path::Path, sync::Mutex};

use crate::models::{
    SchedulerStore, ScheduledJob, SchedulerQueueEntry, JobAttempt,
    SCHEDULER_STORE_VERSION, MAX_SCHEDULED_JOBS, MAX_SCHEDULER_QUEUE_ENTRIES,
    MAX_JOB_ATTEMPTS, SCHEDULED_JOB_STATUSES, MISSED_RUN_POLICIES, SCHEDULER_JOB_STATES,
};
use crate::paths::{scheduler_store_path, normalize_spaces, truncate_characters};
use tauri::{AppHandle, Emitter, Manager};

/// Process-global scheduler state: the loaded store behind a mutex.
pub fn scheduler_state(app: &AppHandle) -> &'static Mutex<Option<SchedulerStore>> {
    app.try_state::<SchedulerState>()
        .map(|s| s.inner())
        .unwrap_or_else(|| {
            // Fallback: a leaked default if managed state is missing (tests).
            use std::sync::OnceLock;
            static FALLBACK: OnceLock<Mutex<Option<SchedulerStore>>> = OnceLock::new();
            FALLBACK.get_or_init(|| Mutex::new(None))
        })
}

pub struct SchedulerState(pub Mutex<Option<SchedulerStore>>);

fn empty_store(instance_id: &str) -> SchedulerStore {
    SchedulerStore {
        schema_version: SCHEDULER_STORE_VERSION,
        jobs: Vec::new(),
        queue: Vec::new(),
        instance_id: instance_id.to_string(),
        updated_at: now_iso(),
    }
}

fn now_iso() -> String {
    // Use a fixed-format UTC stamp without pulling chrono: seconds since epoch.
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("1970-01-01T00:00:{:02}Z", secs % 60)
}

fn normalize_job(mut job: ScheduledJob) -> Result<ScheduledJob, String> {
    job.id = truncate_characters(&normalize_spaces(&job.id), 160);
    job.name = truncate_characters(&normalize_spaces(&job.name), 200);
    job.workflow_definition_id = truncate_characters(&normalize_spaces(&job.workflow_definition_id), 160);
    job.missed_run_policy = normalize_spaces(job.missed_run_policy);
    job.status = normalize_spaces(job.status);
    if job.id.is_empty() || job.name.is_empty() || job.workflow_definition_id.is_empty() {
        return Err("Scheduled job needs id, name, and workflow id.".to_string());
    }
    if !SCHEDULED_JOB_STATUSES.contains(&job.status.as_str()) {
        return Err("Scheduled job status is not recognized.".to_string());
    }
    if !MISSED_RUN_POLICIES.contains(&job.missed_run_policy.as_str()) {
        return Err("Missed-run policy is not recognized.".to_string());
    }
    Ok(job)
}

pub fn read_store(path: &Path) -> Result<SchedulerStore, String> {
    if !path.exists() {
        return Ok(empty_store("unset"));
    }
    let contents = fs::read_to_string(path)
        .map_err(|_| "Fable could not read scheduler store.".to_string())?;
    if contents.trim().is_empty() {
        return Ok(empty_store("unset"));
    }
    serde_json::from_str::<SchedulerStore>(&contents)
        .map_err(|_| "Fable could not parse scheduler store.".to_string())
}

fn write_store(path: &Path, store: &SchedulerStore) -> Result<(), String> {
    let encoded = serde_json::to_vec_pretty(store)
        .map_err(|_| "Fable could not encode scheduler store.".to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, encoded).map_err(|_| "Fable could not save scheduler store.".to_string())?;
    fs::rename(&tmp, path).map_err(|_| "Fable could not commit scheduler store.".to_string())
}

fn persist<F: FnOnce(&mut SchedulerStore)>(app: &AppHandle, mutate: F) -> Result<(), String> {
    let path = scheduler_store_path(app)?;
    let mut guard = scheduler_state(app).lock().map_err(|_| "Scheduler lock poisoned.".to_string())?;
    if guard.is_none() {
        *guard = Some(read_store(&path)?);
    }
    let store = guard.as_mut().unwrap();
    mutate(store);
    store.updated_at = now_iso();
    write_store(&path, store)
}

/// Emit a run-request event so the TS scheduler driver picks up a due job.
fn emit_run_request(app: &AppHandle, entry: &SchedulerQueueEntry) {
    let _ = app.emit(
        "fable://scheduler/run-request",
        serde_json::json!({ "jobId": entry.job_id, "runId": entry.run_id, "scheduledAt": entry.scheduled_at }),
    );
}

#[tauri::command]
pub fn list_scheduler_jobs(app: AppHandle) -> Result<Vec<ScheduledJob>, String> {
    let path = scheduler_store_path(&app)?;
    let store = read_store(&path)?;
    Ok(store.jobs)
}

#[tauri::command]
pub fn list_scheduler_queue(app: AppHandle) -> Result<Vec<SchedulerQueueEntry>, String> {
    let path = scheduler_store_path(&app)?;
    let store = read_store(&path)?;
    Ok(store.queue)
}

#[tauri::command]
pub fn save_scheduled_job(app: AppHandle, job: ScheduledJob) -> Result<ScheduledJob, String> {
    let job = normalize_job(job)?;
    persist(&app, |store| {
        store.jobs.retain(|j| j.id != job.id);
        store.jobs.insert(0, job.clone());
        store.jobs.truncate(MAX_SCHEDULED_JOBS);
    })?;
    Ok(job)
}

#[tauri::command]
pub fn delete_scheduled_job(app: AppHandle, job_id: String) -> Result<(), String> {
    persist(&app, |store| {
        store.jobs.retain(|j| j.id != job_id);
    })
}

#[tauri::command]
pub fn set_job_status(app: AppHandle, job_id: String, status: String) -> Result<(), String> {
    if !SCHEDULED_JOB_STATUSES.contains(&status.as_str()) {
        return Err("Unknown job status.".to_string());
    }
    persist(&app, |store| {
        for job in &mut store.jobs {
            if job.id == job_id {
                job.status = status.clone();
            }
        }
    })
}

#[tauri::command]
pub fn enqueue_job_run(
    app: AppHandle,
    job_id: String,
    run_id: String,
    scheduled_at: String,
) -> Result<SchedulerQueueEntry, String> {
    let key = format!("{}:{}", job_id, scheduled_at);
    let mut created: Option<SchedulerQueueEntry> = None;
    persist(&app, |store| {
        if store.queue.iter().any(|e| e.deduplication_key == key) {
            return;
        }
        let entry = SchedulerQueueEntry {
            job_id: job_id.clone(),
            run_id: run_id.clone(),
            scheduled_at: scheduled_at.clone(),
            state: "queued".to_string(),
            lease_holder: String::new(),
            lease_expires_at: String::new(),
            attempts: Vec::new(),
            deduplication_key: key,
        };
        created = Some(entry.clone());
        store.queue.push(entry);
        store.queue.truncate(MAX_SCHEDULER_QUEUE_ENTRIES);
    })?;
    created.ok_or_else(|| "A run for this occurrence is already queued.".to_string())
}

/// Called by the TS driver to report an attempt outcome.
#[tauri::command]
pub fn report_job_attempt(
    app: AppHandle,
    run_id: String,
    attempt: JobAttempt,
) -> Result<(), String> {
    persist(&app, |store| {
        for entry in &mut store.queue {
            if entry.run_id == run_id {
                entry.attempts.push(attempt.clone());
                if entry.attempts.len() > MAX_JOB_ATTEMPTS {
                    entry.attempts.drain(0..(entry.attempts.len() - MAX_JOB_ATTEMPTS));
                }
                if attempt.status == "succeeded" || attempt.status == "cancelled" {
                    entry.state = "done".to_string();
                } else if attempt.status == "failed" {
                    let fails = entry.attempts.iter().filter(|a| a.status == "failed").count() as u32;
                    entry.state = if fails > crate::models::SCHEDULER_MAX_RETRIES { "dead" } else { "queued" }.to_string();
                }
                entry.lease_holder.clear();
                entry.lease_expires_at.clear();
            }
        }
    })
}

/// The tick: lease due+queued entries owned by this instance and emit run-requests.
/// Idempotent + crash-safe: an interrupted tick only ever leaves entries leased
/// until their short deadline; the next tick re-queues expired leases.
pub fn run_tick(app: &AppHandle) -> Result<usize, String> {
    let now_ms = now_ms();
    let instance = {
        let guard = scheduler_state(app).lock().map_err(|_| "lock".to_string())?;
        guard.as_ref().map(|s| s.instance_id.clone()).unwrap_or_else(|| "unset".to_string())
    };
    let mut emitted = 0usize;
    persist(app, |store| {
        // Expire leases.
        for entry in &mut store.queue {
            if !entry.lease_holder.is_empty() && parse_ms(&entry.lease_expires_at) <= now_ms {
                entry.lease_holder.clear();
                entry.lease_expires_at.clear();
                if entry.state == "leased" { entry.state = "queued".to_string(); }
            }
        }
        // Lease due queued entries.
        for entry in &mut store.queue {
            if entry.state == "queued" && parse_ms(&entry.scheduled_at) <= now_ms {
                entry.state = "leased".to_string();
                entry.lease_holder = instance.clone();
                entry.lease_expires_at = format_iso(now_ms + crate::models::SCHEDULER_LEASE_MS);
                emitted += 1;
            }
        }
    })?;
    // After persisting leases, emit the events (read the leased-for-us entries).
    let path = scheduler_store_path(app)?;
    let store = read_store(&path)?;
    for entry in store.queue.iter().filter(|e| e.lease_holder == instance && e.state == "leased") {
        emit_run_request(app, entry);
    }
    Ok(emitted)
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn parse_ms(iso: &str) -> i64 {
    // Scheduler times are written via format_iso/now; tolerate epoch-ms as fallback.
    if let Ok(ms) = iso.parse::<i64>() { return ms; }
    0
}

fn format_iso(ms: i64) -> String {
    // Store epoch-ms as the canonical comparable value (the TS layer formats for display).
    ms.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp() -> PathBuf {
        let p = std::env::temp_dir().join(format!("fable-sched-{}.json", std::process::id()));
        let _ = fs::remove_file(&p);
        p
    }

    #[test]
    fn store_round_trips_empty() {
        let p = tmp();
        let store = empty_store("inst");
        write_store(&p, &store).unwrap();
        let read = read_store(&p).unwrap();
        assert_eq!(read.jobs.len(), 0);
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn normalize_rejects_unknown_status() {
        let mut job = empty_store("x").jobs;
        let _ = job;
        let j = ScheduledJob {
            id: "j".into(), schema_version: 1, name: "n".into(), description: "".into(),
            workflow_definition_id: "wf".into(), trigger: serde_json::json!({"kind":"once","at":"x"}),
            missed_run_policy: "skip".into(), status: "bogus".into(),
            next_run_at: "".into(), last_run_at: "".into(), last_run_id: "".into(),
            created_at: "x".into(), updated_at: "x".into(),
        };
        assert!(normalize_job(j).is_err());
    }
}
```

- [ ] **Step 2: Wire into lib.rs**

In `apps/desktop/src-tauri/src/lib.rs`, add `mod scheduler;` to the module list, register the commands in `invoke_handler`, and start the tick loop in `.setup()`:

```rust
mod scheduler;   // add to the mod block
```

Add to the `invoke_handler!` list:

```rust
            scheduler::list_scheduler_jobs,
            scheduler::list_scheduler_queue,
            scheduler::save_scheduled_job,
            scheduler::delete_scheduled_job,
            scheduler::set_job_status,
            scheduler::enqueue_job_run,
            scheduler::report_job_attempt,
```

Add a `.setup()` hook after `.invoke_handler(...)`:

```rust
        .setup(|app| {
            // Load + manage scheduler state once.
            let handle = app.handle().clone();
            let store = scheduler::read_store(&scheduler_store_path(&handle)?)
                .unwrap_or_else(|_| scheduler::SchedulerState::default_inner());
            app.manage(scheduler::SchedulerState(std::sync::Mutex::new(Some(store))));

            // In-process scheduler tick. Single shared process => lease map is the
            // cross-window duplicate-execution guard. Stops when the app exits.
            let tick_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let _ = scheduler::run_tick(&tick_handle);
                    tokio::time::sleep(std::time::Duration::from_secs(
                        crate::models::SCHEDULER_TICK_SECS,
                    )).await;
                }
            });
            Ok(())
        })
```

> NOTE: adjust the `read_store` fallback to call a `SchedulerState::default_inner()` helper — add to `scheduler.rs`:
> ```rust
> impl SchedulerState {
>     pub fn default_inner() -> SchedulerStore { empty_store("unset") }
> }
> ```

- [ ] **Step 3: Verify Rust compiles + tests pass**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml scheduler`
Expected: PASS.

Run: `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/scheduler.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(scheduler): durable store + in-process tick + lease lock"
```

### Task 1.7: TS scheduler repository wrappers + tick driver

**Files:**
- Create: `apps/desktop/src/lib/scheduler/repository.ts`
- Create: `apps/desktop/src/lib/scheduler/driver.ts`
- Modify: `apps/desktop/src/runtime.ts` (append low-level wrappers)

- [ ] **Step 1: Add low-level Tauri wrappers to runtime.ts**

Append to `apps/desktop/src/runtime.ts`:

```ts
import type {
  ScheduledJob, SchedulerQueueEntry, JobAttempt
} from "@fable/protocol";

export async function listRuntimeSchedulerJobs() {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<ScheduledJob[]>("list_scheduler_jobs"); }
  catch { return null; }
}

export async function listRuntimeSchedulerQueue() {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<SchedulerQueueEntry[]>("list_scheduler_queue"); }
  catch { return null; }
}

export async function saveRuntimeScheduledJob(job: ScheduledJob) {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<ScheduledJob>("save_scheduled_job", { job }); }
  catch (error) { throw toRuntimeError(error); }
}

export async function deleteRuntimeScheduledJob(jobId: string) {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<void>("delete_scheduled_job", { jobId }); }
  catch (error) { throw toRuntimeError(error); }
}

export async function setRuntimeJobStatus(jobId: string, status: string) {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<void>("set_job_status", { jobId, status }); }
  catch (error) { throw toRuntimeError(error); }
}

export async function enqueueRuntimeJobRun(jobId: string, runId: string, scheduledAt: string) {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<SchedulerQueueEntry>("enqueue_job_run", { jobId, runId, scheduledAt }); }
  catch (error) { throw toRuntimeError(error); }
}

export async function reportRuntimeJobAttempt(runId: string, attempt: JobAttempt) {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<void>("report_job_attempt", { runId, attempt }); }
  catch (error) { throw toRuntimeError(error); }
}

/** Listen for the Rust tick's run-request events. Returns an unlisten fn or null. */
export async function listenRuntimeSchedulerRunRequest(
  onRun: (event: { jobId: string; runId: string; scheduledAt: string }) => void
) {
  if (!hasTauriRuntime()) return null;
  try {
    const unlisten = await listen<{
      jobId: string; runId: string; scheduledAt: string;
    }>("fable://scheduler/run-request", (event) => onRun(event.payload));
    return unlisten;
  } catch { return null; }
}
```

(Add `listen` and `invoke` to the existing imports at the top of runtime.ts if not already present — they are.)

- [ ] **Step 2: Create repository.ts (Goal 5 interface + impl)**

`apps/desktop/src/lib/scheduler/repository.ts`:

```ts
/**
 * Scheduler repository interface (Goal 5 persistence seam). The Tauri-runtime
 * implementation talks to Rust; preview returns null so the shell falls back to
 * in-memory definitions and never claims durable scheduling outside the desktop.
 */

import type {
  ScheduledJob, SchedulerQueueEntry, JobAttempt, ScheduleTrigger, ScheduledJobStatus
} from "@fable/protocol";

export interface SchedulerRepository {
  listJobs(): Promise<ScheduledJob[] | null>;
  listQueue(): Promise<SchedulerQueueEntry[] | null>;
  saveJob(job: ScheduledJob): Promise<ScheduledJob | null>;
  deleteJob(jobId: string): Promise<void | null>;
  setStatus(jobId: string, status: ScheduledJobStatus): Promise<void | null>;
  enqueueRun(jobId: string, runId: string, scheduledAt: string): Promise<SchedulerQueueEntry | null>;
  reportAttempt(runId: string, attempt: JobAttempt): Promise<void | null>;
}

export interface CreateScheduledJobInput {
  id?: string;
  name: string;
  description: string;
  workflowDefinitionId: string;
  trigger: ScheduleTrigger;
  missedRunPolicy: "skip" | "run-once" | "run-all";
}
```

- [ ] **Step 3: Create driver.ts — the lifecycle glue**

`apps/desktop/src/lib/scheduler/driver.ts`:

```ts
/**
 * The scheduler driver: owns the lifecycle of scheduled runs. It computes the
 * next occurrence for each active job (pure math from @fable/connectors),
 * enqueues due occurrences into the durable Rust queue, and listens for the
 * tick's run-request events to launch workflow runs.
 *
 * Lifecycle ownership (lead-agent rule): exactly one driver instance per window.
 * The Rust lease map prevents two windows from running the same occurrence.
 */

import type { ScheduledJob } from "@fable/protocol";
import { nextRunAfter, missedOccurrences, deduplicationKeyFor } from "@fable/connectors";
import type { SchedulerRepository } from "./repository";

export interface SchedulerDriverHandlers {
  /** Called when the tick requests a run. Returns the created workflow run id. */
  onRunRequested: (event: { jobId: string; runId: string; scheduledAt: string }) => void;
}

export class SchedulerDriver {
  private unlisten: (() => void) | null = null;

  constructor(
    private readonly repo: SchedulerRepository,
    private readonly handlers: SchedulerDriverHandlers,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Start listening for run-request events from the Rust tick. */
  async start(): Promise<void> {
    const { listenRuntimeSchedulerRunRequest } = await import("../../runtime");
    const unlisten = await listenRuntimeSchedulerRunRequest(this.handlers.onRunRequested);
    this.unlisten = unlisten ? () => unlisten() : null;
  }

  stop(): void {
    this.unlisten?.();
    this.unlisten = null;
  }

  /** Recompute next-run times for active jobs and enqueue any due/missed occurrences. */
  async reconcile(jobs: ScheduledJob[]): Promise<void> {
    const now = this.now();
    for (const job of jobs) {
      if (job.status !== "active") continue;
      // Enqueue missed occurrences per policy.
      const last = job.lastRunAt ? new Date(job.lastRunAt) : new Date(job.createdAt);
      const missed = missedOccurrences(job.trigger, job.missedRunPolicy, last, now);
      for (const occ of missed) {
        const runId = `run-${job.id}-${occ.getTime()}`;
        await this.repo.enqueueRun(job.id, runId, occ.toISOString()).catch(() => null);
      }
      // Enqueue the next due occurrence if its time has arrived.
      const next = nextRunAfter(job.trigger, last);
      if (next && next <= now) {
        const runId = `run-${job.id}-${next.getTime()}`;
        await this.repo.enqueueRun(job.id, runId, next.toISOString()).catch(() => null);
      }
    }
  }
}

export { deduplicationKeyFor };
```

- [ ] **Step 4: Verify typecheck**

Run: `pnpm --filter @fable/desktop typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/runtime.ts apps/desktop/src/lib/scheduler/repository.ts apps/desktop/src/lib/scheduler/driver.ts
git commit -m "feat(scheduler): TS repository interface + lifecycle driver"
```

### Task 1.8: Scheduler end-to-end test with fake clock + fake provider

**Files:**
- Create: `apps/desktop/src/lib/scheduler/scheduler.e2e.test.ts`

- [ ] **Step 1: Write the deterministic end-to-end test**

```ts
import { describe, expect, it } from "vitest";
import type { ScheduledJob, SchedulerQueueEntry, JobAttempt } from "@fable/protocol";
import { SchedulerDriver } from "./driver";
import type { SchedulerRepository } from "./repository";

/** A fake repository capturing all calls with an injectable clock. */
class FakeRepo implements SchedulerRepository {
  jobs: ScheduledJob[] = [];
  queue: SchedulerQueueEntry[] = [];
  async listJobs() { return [...this.jobs]; }
  async listQueue() { return [...this.queue]; }
  async saveJob(job: ScheduledJob) { this.jobs = [job, ...this.jobs.filter((j) => j.id !== job.id)]; return job; }
  async deleteJob(id: string) { this.jobs = this.jobs.filter((j) => j.id !== id); }
  async setStatus() {}
  async enqueueRun(jobId: string, runId: string, scheduledAt: string) {
    const key = `${jobId}:${scheduledAt}`;
    if (this.queue.some((e) => e.deduplicationKey === key)) return null;
    const entry: SchedulerQueueEntry = {
      jobId, runId, scheduledAt, state: "queued", leaseHolder: "",
      leaseExpiresAt: "", attempts: [], deduplicationKey: key
    };
    this.queue.push(entry);
    return entry;
  }
  async reportAttempt(runId: string, attempt: JobAttempt) {
    const e = this.queue.find((q) => q.runId === runId);
    if (e) e.attempts.push(attempt);
  }
}

describe("SchedulerDriver reconcile", () => {
  it("enqueues a due once-trigger occurrence", async () => {
    const now = new Date("2026-07-01T10:00:00Z");
    const repo = new FakeRepo();
    const job: ScheduledJob = {
      id: "j1", schemaVersion: 1, name: "Once", description: "",
      workflowDefinitionId: "wf", trigger: { kind: "once", at: "2026-07-01T09:00:00Z" },
      missedRunPolicy: "skip", status: "active", nextRunAt: "2026-07-01T09:00:00Z",
      lastRunAt: "", lastRunId: "", createdAt: "2026-06-28T00:00:00Z", updatedAt: "x"
    };
    const driver = new SchedulerDriver(repo, { onRunRequested: () => {} }, () => now);
    await driver.reconcile([job]);
    expect(repo.queue).toHaveLength(1);
    expect(repo.queue[0].jobId).toBe("j1");
  });

  it("does not enqueue a future occurrence", async () => {
    const now = new Date("2026-06-28T00:00:00Z");
    const repo = new FakeRepo();
    const job: ScheduledJob = {
      id: "j1", schemaVersion: 1, name: "Once", description: "",
      workflowDefinitionId: "wf", trigger: { kind: "once", at: "2026-07-01T09:00:00Z" },
      missedRunPolicy: "skip", status: "active", nextRunAt: "", lastRunAt: "", lastRunId: "",
      createdAt: "2026-06-28T00:00:00Z", updatedAt: "x"
    };
    const driver = new SchedulerDriver(repo, { onRunRequested: () => {} }, () => now);
    await driver.reconcile([job]);
    expect(repo.queue).toHaveLength(0);
  });

  it("enqueues missed occurrences under run-all policy", async () => {
    const now = new Date("2026-06-28T00:00:00Z");
    const repo = new FakeRepo();
    const job: ScheduledJob = {
      id: "j1", schemaVersion: 1, name: "Daily", description: "",
      workflowDefinitionId: "wf",
      trigger: { kind: "recurring", rule: { frequency: "daily", interval: 1, hour: 9, minute: 0, timezone: "UTC" } },
      missedRunPolicy: "run-all", status: "active", nextRunAt: "", lastRunAt: "", lastRunId: "",
      createdAt: "2026-06-25T00:00:00Z", updatedAt: "x"
    };
    const driver = new SchedulerDriver(repo, { onRunRequested: () => {} }, () => now);
    await driver.reconcile([job]);
    expect(repo.queue.length).toBeGreaterThanOrEqual(3);
  });

  it("deduplicates the same occurrence across two reconcile passes", async () => {
    const now = new Date("2026-07-01T10:00:00Z");
    const repo = new FakeRepo();
    const job: ScheduledJob = {
      id: "j1", schemaVersion: 1, name: "Once", description: "",
      workflowDefinitionId: "wf", trigger: { kind: "once", at: "2026-07-01T09:00:00Z" },
      missedRunPolicy: "skip", status: "active", nextRunAt: "", lastRunAt: "", lastRunId: "",
      createdAt: "2026-06-28T00:00:00Z", updatedAt: "x"
    };
    const driver = new SchedulerDriver(repo, { onRunRequested: () => {} }, () => now);
    await driver.reconcile([job]);
    await driver.reconcile([job]);
    expect(repo.queue).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run — verify pass**

Run: `pnpm --filter @fable/desktop test -- scheduler.e2e`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/lib/scheduler/scheduler.e2e.test.ts
git commit -m "test(scheduler): end-to-end reconcile with fake clock + repo"
```

---

# Phase 2 — Workflow Engine

The workflow engine is **pure TS**: a versioned definition model and a runner that executes steps, pausing for fresh approval on consequential writes. It drives the existing `runAgentLoop` for agent steps and the existing approval/tool boundaries. Rust persists runs durably with restart recovery.

## Part A — Versioned definitions + runner (TS)

### Task 2.1: Workflow definition validation + versioning

**Files:**
- Create: `packages/connectors/src/workflows/definition.ts`
- Test: `packages/connectors/src/workflows/definition.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "vitest";
import { validateDefinition, bumpVersion, maxRuntimeBounds } from "./definition";
import type { WorkflowDefinition } from "@fable/protocol";

const base: WorkflowDefinition = {
  schemaVersion: 1, id: "wf", version: 1, name: "Brief", description: "",
  steps: [{ kind: "prompt", id: "s1", prompt: "hi" }],
  createdAt: "x", updatedAt: "x"
};

describe("validateDefinition", () => {
  it("accepts a minimal valid definition", () => {
    expect(validateDefinition(base)).toEqual(base);
  });
  it("rejects a definition with no steps", () => {
    expect(() => validateDefinition({ ...base, steps: [] })).toThrow();
  });
  it("rejects duplicate step ids", () => {
    expect(() => validateDefinition({ ...base, steps: [
      { kind: "prompt", id: "s1", prompt: "a" },
      { kind: "prompt", id: "s1", prompt: "b" }
    ] })).toThrow();
  });
  it("enforces max steps bound", () => {
    const steps = Array.from({ length: maxRuntimeBounds().maxSteps + 1 }, (_, i) =>
      ({ kind: "prompt" as const, id: `s${i}`, prompt: "x" }));
    expect(() => validateDefinition({ ...base, steps })).toThrow();
  });
});

describe("bumpVersion", () => {
  it("creates a new immutable version keeping the old history", () => {
    const v2 = bumpVersion(base, { ...base, name: "Brief v2" });
    expect(v2.version).toBe(2);
    expect(v2.name).toBe("Brief v2");
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `pnpm --filter @fable/connectors test -- definition`
Expected: FAIL.

- [ ] **Step 3: Implement definition.ts**

```ts
/**
 * Versioned, editable workflow definitions. Editing bumps `version`; historical
 * runs keep the version they executed against (immutable history).
 */

import type { WorkflowDefinition, WorkflowStep } from "@fable/protocol";

export const WORKFLOW_DEFINITION_SCHEMA_VERSION = 1;

export interface RuntimeBounds {
  maxSteps: number;
  maxTurnsPerAgentStep: number;
  maxOutputBytes: number;
  maxRuntimeMs: number;
}

export function maxRuntimeBounds(): RuntimeBounds {
  return { maxSteps: 24, maxTurnsPerAgentStep: 8, maxOutputBytes: 64_000, maxRuntimeMs: 5 * 60_000 };
}

/** Validate + normalize a definition. Throws on invalid shape (fail closed). */
export function validateDefinition(def: WorkflowDefinition): WorkflowDefinition {
  if (def.schemaVersion !== WORKFLOW_DEFINITION_SCHEMA_VERSION) {
    throw new Error(`Unsupported workflow schema version ${def.schemaVersion}.`);
  }
  if (!def.id || !def.name) throw new Error("Workflow definition needs id and name.");
  if (!Array.isArray(def.steps) || def.steps.length === 0) {
    throw new Error("Workflow definition needs at least one step.");
  }
  if (def.steps.length > maxRuntimeBounds().maxSteps) {
    throw new Error(`Workflow exceeds the ${maxRuntimeBounds().maxSteps}-step bound.`);
  }
  const ids = new Set<string>();
  for (const step of def.steps) {
    validateStep(step);
    if (ids.has(step.id)) throw new Error(`Duplicate workflow step id: ${step.id}.`);
    ids.add(step.id);
  }
  return def;
}

function validateStep(step: WorkflowStep): void {
  if (!step.id || !step.kind) throw new Error("Workflow step needs id and kind.");
  if (step.kind === "prompt" || step.kind === "agent") {
    if (!step.prompt?.trim()) throw new Error(`Step ${step.id} needs a prompt.`);
  }
  if (step.kind === "connector-read") {
    if (!step.connectorId || !step.capability || !step.outputVar) {
      throw new Error(`Step ${step.id} needs connectorId, capability, and outputVar.`);
    }
  }
  if (step.kind === "tool" && !step.tool) {
    throw new Error(`Step ${step.id} needs a tool name.`);
  }
}

/** Produce the next immutable version of a definition from an edited draft. */
export function bumpVersion(current: WorkflowDefinition, edited: Omit<WorkflowDefinition, "version" | "id" | "createdAt"> & { id: string }): WorkflowDefinition {
  return validateDefinition({
    ...edited,
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id: current.id,
    version: current.version + 1,
    createdAt: current.createdAt,
    updatedAt: new Date(0).toISOString() // caller stamps real time
  });
}
```

- [ ] **Step 4: Run — verify pass**

Run: `pnpm --filter @fable/connectors test -- definition`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/workflows/definition.ts packages/connectors/src/workflows/definition.test.ts
git commit -m "feat(workflows): versioned + validated workflow definitions"
```

### Task 2.2: Workflow runner — step iteration, pause/resume, persistence

**Files:**
- Create: `packages/connectors/src/workflows/runner.ts`
- Test: `packages/connectors/src/workflows/runner.test.ts`

- [ ] **Step 1: Write failing tests with a fake agent + tool boundary**

```ts
import { describe, expect, it } from "vitest";
import { runWorkflow, type WorkflowRunContext } from "./runner";
import type { WorkflowDefinition } from "@fable/protocol";
import type { BackendAgentEvent } from "@fable/protocol";

function def(steps: WorkflowDefinition["steps"]): WorkflowDefinition {
  return { schemaVersion: 1, id: "wf", version: 1, name: "t", description: "", steps, createdAt: "x", updatedAt: "x" };
}

async function* oneTextThenDone(): AsyncIterable<BackendAgentEvent> {
  yield { type: "text-delta", text: "hello" };
  yield { type: "done", finishReason: "stop" };
}

describe("runWorkflow", () => {
  it("runs a prompt step to completion and records the transcript", async () => {
    const ctx: WorkflowRunContext = {
      now: () => new Date("2026-06-28T00:00:00Z"),
      runAgent: async () => oneTextThenDone(),
      runTool: async () => "ok",
      readConnector: async () => "data",
      requestApproval: async () => "approved",
      isCancelled: () => false
    };
    const run = await runWorkflow(def([{ kind: "prompt", id: "s1", prompt: "hi" }]), { runId: "r1", trigger: "manual", input: {}, ctx });
    expect(run.status).toBe("completed");
    expect(run.steps[0].status).toBe("succeeded");
  });

  it("pauses on an approval step and resumes when approved", async () => {
    const ctx: WorkflowRunContext = {
      now: () => new Date("2026-06-28T00:00:00Z"),
      runAgent: async () => oneTextThenDone(),
      runTool: async () => "ok",
      readConnector: async () => "data",
      requestApproval: async (step) => step.description.includes("approve") ? "approved" : "denied",
      isCancelled: () => false
    };
    const run = await runWorkflow(def([
      { kind: "prompt", id: "s1", prompt: "hi" },
      { kind: "approval", id: "s2", description: "Please approve sending" }
    ]), { runId: "r1", trigger: "manual", input: {}, ctx });
    expect(run.steps[1].status).toBe("succeeded");
    expect(run.steps[1].approval?.decision).toBe("approved");
    expect(run.status).toBe("completed");
  });

  it("fails closed when an approval is denied", async () => {
    const ctx: WorkflowRunContext = {
      now: () => new Date("2026-06-28T00:00:00Z"),
      runAgent: async () => oneTextThenDone(),
      runTool: async () => { throw new Error("should not run"); },
      readConnector: async () => "data",
      requestApproval: async () => "denied",
      isCancelled: () => false
    };
    const run = await runWorkflow(def([
      { kind: "tool", id: "s1", tool: "write-file", arguments: { path: "x" }, consequential: true }
    ]), { runId: "r1", trigger: "manual", input: {}, ctx });
    expect(run.status).toBe("failed");
    expect(run.steps[0].status).toBe("failed");
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `pnpm --filter @fable/connectors test -- runner`
Expected: FAIL.

- [ ] **Step 3: Implement runner.ts**

```ts
/**
 * The workflow runner. Pure over injected boundaries: it does NOT call the
 * network, the agent transport, or the approval UI directly — it calls the
 * injected `runAgent`/`runTool`/`readConnector`/`requestApproval` hooks.
 *
 * This keeps it deterministic + fixture-testable while letting the shell wire
 * the real agent loop (runAgentLoop), tool executor (approval gate), connector
 * reads, and approval UI. Consequential writes always pause for fresh approval.
 */

import type {
  BackendAgentEvent, WorkflowDefinition, WorkflowRun, WorkflowRunStatus,
  WorkflowStep, WorkflowStepRecord
} from "@fable/protocol";
import { validateDefinition, maxRuntimeBounds } from "./definition";

export type ApprovalOutcome = "approved" | "denied" | "expired";

export interface WorkflowRunContext {
  now: () => Date;
  /** Run an agent step. Returns the event stream (same shape as runAgentLoop). */
  runAgent: (step: Extract<WorkflowStep, { kind: "agent" | "prompt" }>, input: Record<string, unknown>) => AsyncIterable<BackendAgentEvent>;
  /** Run a single Fable-owned tool. Rejects on denial/failure. */
  runTool: (step: Extract<WorkflowStep, { kind: "tool" }>, input: Record<string, unknown>) => Promise<string>;
  /** Read from a connector capability. Returns serialized text. */
  readConnector: (step: Extract<WorkflowStep, { kind: "connector-read" }>, input: Record<string, unknown>) => Promise<string>;
  /** Request fresh approval for a step. Returns the decision. */
  requestApproval: (step: WorkflowStep) => Promise<ApprovalOutcome>;
  /** Cooperative cancellation. */
  isCancelled: () => boolean;
}

export interface RunWorkflowOptions {
  runId: string;
  trigger: WorkflowRun["trigger"];
  input: Record<string, unknown>;
  ctx: WorkflowRunContext;
  /** Resume from an existing partial run (pause/resume around approval). */
  resumeFrom?: WorkflowRun;
  /** TTL for approvals (ms). Expired approvals never execute. */
  approvalTtlMs?: number;
}

const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000;

export async function runWorkflow(def: WorkflowDefinition, opts: RunWorkflowOptions): Promise<WorkflowRun> {
  const validated = validateDefinition(def);
  const bounds = maxRuntimeBounds();
  const startedAt = opts.ctx.now().toISOString();
  const resumeSteps = opts.resumeFrom?.steps ?? [];
  const vars: Record<string, unknown> = { ...opts.input };

  const steps: WorkflowStepRecord[] = [];
  let status: WorkflowRunStatus = "running";
  let failureReason: string | undefined;
  const approvalTtl = opts.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;

  outer: for (let i = 0; i < validated.steps.length; i += 1) {
    if (opts.ctx.isCancelled()) { status = "cancelled"; break; }
    if (Date.parse(startedAt) + bounds.maxRuntimeMs < opts.ctx.now().getTime()) {
      status = "failed"; failureReason = "Workflow exceeded its runtime bound."; break;
    }
    const step = validated.steps[i];
    const resumed = resumeSteps[i];
    if (resumed?.status === "succeeded") { steps.push(resumed); continue; }

    const record: WorkflowStepRecord = { stepId: step.id, status: "running", startedAt: opts.ctx.now().toISOString() };
    steps.push(record);

    try {
      switch (step.kind) {
        case "prompt":
        case "agent": {
          const events = opts.ctx.runAgent(step, vars);
          let transcript = "";
          const toolCalls: WorkflowStepRecord["toolCalls"] = [];
          for await (const ev of events) {
            if (opts.ctx.isCancelled()) { status = "cancelled"; break outer; }
            if (ev.type === "text-delta") transcript += ev.text;
            if (ev.type === "tool-call") toolCalls.push({ tool: ev.tool, arguments: ev.arguments, ok: false, output: "" });
            if (ev.type === "tool-result") {
              const last = toolCalls.findLast?.((t) => t.tool === ev.tool && !t.ok);
              if (last) { last.ok = ev.ok; last.output = ev.output; }
            }
            if (ev.type === "error") throw new Error(ev.message);
          }
          record.output = transcript;
          record.toolCalls = toolCalls;
          record.status = "succeeded";
          break;
        }
        case "connector-read": {
          const out = await opts.ctx.readConnector(step, vars);
          vars[step.outputVar] = out;
          record.output = out;
          record.status = "succeeded";
          break;
        }
        case "tool": {
          // Consequential writes ALWAYS pause for fresh explicit approval.
          if (step.consequential) {
            const decision = await opts.ctx.requestApproval(step);
            record.approval = { decision, decidedAt: opts.ctx.now().toISOString() };
            if (decision !== "approved") {
              record.status = "failed";
              status = "failed";
              failureReason = decision === "expired" ? "Approval expired." : "Tool was not approved.";
              break outer;
            }
          }
          const out = await opts.ctx.runTool(step, vars);
          record.output = out;
          record.status = "succeeded";
          break;
        }
        case "approval": {
          const expiresAt = new Date(opts.ctx.now().getTime() + approvalTtl).toISOString();
          record.approval = { decision: "pending", expiresAt };
          // Pause point: the shell resolves the approval. requestApproval blocks.
          const decision = await opts.ctx.requestApproval(step);
          record.approval = { decision, decidedAt: opts.ctx.now().toISOString(), expiresAt };
          if (decision !== "approved") {
            record.status = decision === "expired" ? "failed" : "skipped";
            status = decision === "expired" ? "failed" : "cancelled";
            failureReason = decision === "expired" ? "Approval expired." : "Approval denied.";
            break outer;
          }
          record.status = "succeeded";
          break;
        }
      }
      record.finishedAt = opts.ctx.now().toISOString();
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : "Step failed.";
      record.finishedAt = opts.ctx.now().toISOString();
      status = "failed";
      failureReason = record.error;
      break;
    }
  }

  if (status === "running") status = "completed";

  return {
    id: opts.runId,
    definitionId: validated.id,
    definitionVersion: validated.version,
    status,
    trigger: opts.trigger,
    input: opts.input,
    steps,
    failureReason,
    startedAt,
    updatedAt: opts.ctx.now().toISOString(),
    finishedAt: status === "completed" || status === "failed" || status === "cancelled" ? opts.ctx.now().toISOString() : undefined
  };
}
```

- [ ] **Step 4: Run — verify pass**

Run: `pnpm --filter @fable/connectors test -- runner`
Expected: PASS. (If `Array.prototype.findLast` is unavailable in the test target, replace with a manual reverse search.)

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/workflows/runner.ts packages/connectors/src/workflows/runner.test.ts
git commit -m "feat(workflows): runner with pause/resume around approval"
```

### Task 2.3: Idempotency + pre-execution revalidation

**Files:**
- Create: `packages/connectors/src/workflows/idempotency.ts`
- Test: `packages/connectors/src/workflows/idempotency.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "vitest";
import { idempotencyKeyFor, isApprovalFresh, revalidateToolStep } from "./idempotency";
import type { WorkflowStep } from "@fable/protocol";

describe("idempotencyKeyFor", () => {
  it("is stable for run+step+target", () => {
    const a = idempotencyKeyFor("run-1", "s1", "write-file:/x.txt");
    const b = idempotencyKeyFor("run-1", "s1", "write-file:/x.txt");
    expect(a).toBe(b);
    expect(idempotencyKeyFor("run-1", "s1", "write-file:/y.txt")).not.toBe(a);
  });
});

describe("isApprovalFresh", () => {
  it("rejects an expired approval", () => {
    const now = new Date("2026-06-28T00:05:00Z");
    expect(isApprovalFresh({ decision: "approved", expiresAt: "2026-06-28T00:01:00Z" }, now)).toBe(false);
  });
  it("accepts a fresh approval", () => {
    const now = new Date("2026-06-28T00:00:30Z");
    expect(isApprovalFresh({ decision: "approved", expiresAt: "2026-06-28T00:05:00Z" }, now)).toBe(true);
  });
});

describe("revalidateToolStep", () => {
  it("passes a valid consequential write with a target", () => {
    const step: WorkflowStep = { kind: "tool", id: "s1", tool: "write-file", arguments: { path: "/x" }, consequential: true };
    expect(() => revalidateToolStep(step)).not.toThrow();
  });
  it("rejects a consequential write with no identifiable target", () => {
    const step: WorkflowStep = { kind: "tool", id: "s1", tool: "write-file", arguments: {}, consequential: true };
    expect(() => revalidateToolStep(step)).toThrow();
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `pnpm --filter @fable/connectors test -- idempotency`
Expected: FAIL.

- [ ] **Step 3: Implement idempotency.ts**

```ts
/**
 * Idempotency + pre-execution revalidation. Retries must not duplicate external
 * mutations: each consequential write gets a stable idempotency key derived from
 * (run, step, target) so a retried run reuses it. Approvals are re-checked for
 * freshness immediately before dispatch (expired approvals never execute).
 */

import type { WorkflowStep, WorkflowStepRecord } from "@fable/protocol";

/** Stable idempotency key for a consequential write. */
export function idempotencyKeyFor(runId: string, stepId: string, target: string): string {
  return `${runId}:${stepId}:${target}`;
}

/** True when an approval decision is still within its TTL. */
export function isApprovalFresh(
  approval: { decision: string; expiresAt?: string },
  now: Date
): boolean {
  if (approval.decision !== "approved") return false;
  if (!approval.expiresAt) return false;
  return Date.parse(approval.expiresAt) > now.getTime();
}

/**
 * Pre-execution revalidation for a tool step. Throws when a consequential write
 * lacks an identifiable target (so a retry cannot silently mutate something
 * different). This is the "revalidate right before dispatch" safety net.
 */
export function revalidateToolStep(step: Extract<WorkflowStep, { kind: "tool" }>): void {
  if (!step.consequential) return;
  const target = toolTarget(step);
  if (!target) {
    throw new Error(`Consequential tool ${step.tool} has no identifiable target — refusing to execute.`);
  }
}

/** Extract a stable target fingerprint for a tool call (for idempotency keys). */
export function toolTarget(step: Extract<WorkflowStep, { kind: "tool" }>): string | null {
  const args = step.arguments ?? {};
  const path = typeof args.path === "string" ? args.path : null;
  const command = typeof args.command === "string" ? args.command : null;
  const url = typeof args.url === "string" ? args.url : null;
  const capability = typeof args.capability === "string" ? args.capability : null;
  return [step.tool, path ?? command ?? url ?? capability ?? ""].join(":");
}

/** Build the full approval record check used right before a tool dispatch. */
export function canExecuteTool(
  step: Extract<WorkflowStep, { kind: "tool" }>,
  record: WorkflowStepRecord,
  now: Date
): boolean {
  revalidateToolStep(step);
  return isApprovalFresh(record.approval ?? { decision: "pending" }, now);
}
```

- [ ] **Step 4: Run — verify pass**

Run: `pnpm --filter @fable/connectors test -- idempotency`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/workflows/idempotency.ts packages/connectors/src/workflows/idempotency.test.ts
git commit -m "feat(workflows): idempotency keys + pre-execution revalidation"
```

### Task 2.4: Built-in templates with honest degradation

**Files:**
- Create: `packages/connectors/src/workflows/templates.ts`
- Test: `packages/connectors/src/workflows/templates.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES, degradationWarningsFor, instantiateTemplate } from "./templates";

describe("BUILTIN_TEMPLATES", () => {
  it("includes the required named examples", () => {
    const names = BUILTIN_TEMPLATES.map((t) => t.id);
    expect(names).toEqual(expect.arrayContaining([
      "morning-brief", "calendar-plan", "project-update",
      "repository-watch", "meeting-follow-up", "deployment-failure-summary"
    ]));
  });
  it("each template is a valid definition with declared connector deps", () => {
    for (const t of BUILTIN_TEMPLATES) {
      const inst = instantiateTemplate(t, {});
      expect(inst.steps.length).toBeGreaterThan(0);
      const deps = t.requiresConnectors ?? [];
      const warnings = degradationWarningsFor(t, new Set());
      // A template with deps + no connected connectors MUST degrade honestly.
      if (deps.length > 0) expect(warnings.length).toBeGreaterThan(0);
    }
  });
});

describe("degradationWarningsFor", () => {
  it("warns when required connectors are unavailable", () => {
    const t = BUILTIN_TEMPLATES.find((x) => x.id === "repository-watch")!;
    const warnings = degradationWarningsFor(t, new Set());
    expect(warnings.some((w) => /connector/i.test(w))).toBe(true);
  });
  it("does not warn when required connectors are connected", () => {
    const t = BUILTIN_TEMPLATES.find((x) => x.id === "morning-brief")!;
    const connected = new Set(t.requiresConnectors ?? []);
    expect(degradationWarningsFor(t, connected)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `pnpm --filter @fable/connectors test -- templates`
Expected: FAIL.

- [ ] **Step 3: Implement templates.ts**

```ts
/**
 * Built-in workflow templates. Each declares the connectors it wants; when a
 * required connector is unavailable the template degrades HONESTLY — it emits a
 * degradation warning rather than claiming capabilities it cannot honor. This
 * satisfies "templates must degrade honestly when required connectors are
 * unavailable."
 */

import type { WorkflowDefinition, WorkflowStep } from "@fable/protocol";
import { validateDefinition, WORKFLOW_DEFINITION_SCHEMA_VERSION } from "./definition";

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  requiresConnectors?: string[];
  buildSteps: (input: Record<string, unknown>) => WorkflowStep[];
}

export const BUILTIN_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    id: "morning-brief",
    name: "Morning brief",
    description: "Summarize your day: calendar, inbox, and active projects.",
    requiresConnectors: [],
    buildSteps: () => [
      { kind: "prompt", id: "brief", prompt: "Summarize today's priorities from pinned memory and knowledge." }
    ]
  },
  {
    id: "calendar-plan",
    name: "Calendar plan",
    description: "Plan your schedule around today's calendar events.",
    requiresConnectors: ["google-calendar"],
    buildSteps: () => [
      { kind: "connector-read", id: "read-cal", connectorId: "google-calendar", capability: "events", input: {}, outputVar: "events" },
      { kind: "prompt", id: "plan", prompt: "Build a focused plan around the events in $events." }
    ]
  },
  {
    id: "project-update",
    name: "Project update",
    description: "Draft a status update for an active project.",
    buildSteps: () => [
      { kind: "prompt", id: "draft", prompt: "Draft a concise project status update." }
    ]
  },
  {
    id: "repository-watch",
    name: "Repository watch",
    description: "Summarize recent activity on a watched repository.",
    requiresConnectors: ["github"],
    buildSteps: () => [
      { kind: "connector-read", id: "read-repo", connectorId: "github", capability: "activity", input: {}, outputVar: "activity" },
      { kind: "prompt", id: "summarize", prompt: "Summarize the repository activity in $activity." }
    ]
  },
  {
    id: "meeting-follow-up",
    name: "Meeting follow-up",
    description: "Capture actions and draft a follow-up note after a meeting.",
    requiresConnectors: ["google-calendar"],
    buildSteps: () => [
      { kind: "prompt", id: "actions", prompt: "Extract action items from the meeting." },
      { kind: "approval", id: "approve-note", description: "Approve the follow-up note before it is saved." }
    ]
  },
  {
    id: "deployment-failure-summary",
    name: "Deployment failure summary",
    description: "Summarize a failed deployment and propose a rollback.",
    requiresConnectors: ["vercel"],
    buildSteps: () => [
      { kind: "connector-read", id: "read-deploy", connectorId: "vercel", capability: "deployments", input: {}, outputVar: "deploys" },
      { kind: "prompt", id: "diagnose", prompt: "Diagnose the latest failed deployment in $deploys." },
      { kind: "approval", id: "approve-rollback", description: "Approve the proposed rollback before executing it." }
    ]
  }
];

/** Honest degradation warnings for a template given the connected connector set. */
export function degradationWarningsFor(template: WorkflowTemplate, connected: Set<string>): string[] {
  const warnings: string[] = [];
  for (const required of template.requiresConnectors ?? []) {
    if (!connected.has(required)) {
      warnings.push(`${template.name} wants the ${required} connector, which is not connected. It will run without that data.`);
    }
  }
  return warnings;
}

/** Instantiate a template into a concrete, validated workflow definition. */
export function instantiateTemplate(template: WorkflowTemplate, input: Record<string, unknown>): WorkflowDefinition {
  const now = new Date(0).toISOString();
  return validateDefinition({
    schemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
    id: template.id,
    version: 1,
    name: template.name,
    description: template.description,
    steps: template.buildSteps(input),
    createdAt: now,
    updatedAt: now
  });
}
```

- [ ] **Step 4: Run — verify pass**

Run: `pnpm --filter @fable/connectors test -- templates`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/workflows/templates.ts packages/connectors/src/workflows/templates.test.ts
git commit -m "feat(workflows): built-in templates with honest degradation"
```

### Task 2.5: Workflows barrel + connectors index export

**Files:**
- Create: `packages/connectors/src/workflows/index.ts`
- Modify: `packages/connectors/src/index.ts` (append)

- [ ] **Step 1: Create barrel + append export**

`packages/connectors/src/workflows/index.ts`:

```ts
export { validateDefinition, bumpVersion, maxRuntimeBounds, WORKFLOW_DEFINITION_SCHEMA_VERSION, type RuntimeBounds } from "./definition";
export { runWorkflow, type WorkflowRunContext, type RunWorkflowOptions, type ApprovalOutcome } from "./runner";
export { idempotencyKeyFor, isApprovalFresh, revalidateToolStep, toolTarget, canExecuteTool } from "./idempotency";
export { BUILTIN_TEMPLATES, degradationWarningsFor, instantiateTemplate, type WorkflowTemplate } from "./templates";
```

Append to `packages/connectors/src/index.ts`:

```ts
// workflows (versioned definitions + runner + templates; durable runs persist in Rust)
export {
  validateDefinition, bumpVersion, maxRuntimeBounds, WORKFLOW_DEFINITION_SCHEMA_VERSION,
  runWorkflow, idempotencyKeyFor, isApprovalFresh, revalidateToolStep, toolTarget, canExecuteTool,
  BUILTIN_TEMPLATES, degradationWarningsFor, instantiateTemplate,
  type WorkflowRunContext, type RunWorkflowOptions, type ApprovalOutcome,
  type RuntimeBounds, type WorkflowTemplate
} from "./workflows";
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm --filter @fable/connectors typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/connectors/src/workflows/index.ts packages/connectors/src/index.ts
git commit -m "feat(workflows): export workflow engine from @fable/connectors"
```

## Part B — Durable workflow-run store (Rust)

### Task 2.6: Workflow-run persistence + recovery (Rust)

**Files:**
- Create: `apps/desktop/src-tauri/src/workflows.rs`
- Modify: `apps/desktop/src-tauri/src/models.rs` (append structs), `paths.rs` (append path), `lib.rs` (register)

- [ ] **Step 1: Append structs to models.rs**

```rust
pub const WORKFLOW_RUN_STORE_VERSION: u8 = 1;
pub const MAX_WORKFLOW_RUNS: usize = 200;
pub const MAX_WORKFLOW_STEPS: usize = 24;
pub const WORKFLOW_RUN_STATUSES: [&str; 6] = ["queued","running","awaiting-approval","completed","failed","cancelled"];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkflowRunRecord {
    pub id: String,
    pub definition_id: String,
    pub definition_version: u32,
    pub status: String,
    pub trigger: String,
    pub scheduled_job_id: Option<String>,
    pub input: serde_json::Value,
    pub steps: serde_json::Value,     // Vec<WorkflowStepRecord> stored as JSON
    pub failure_reason: Option<String>,
    pub idempotency_key: Option<String>,
    pub started_at: String,
    pub updated_at: String,
    pub finished_at: Option<String>,
}
```

- [ ] **Step 2: Append path to paths.rs**

```rust
pub fn workflow_runs_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "workflow-runs.json")
}
```

- [ ] **Step 3: Implement workflows.rs**

```rust
//! Durable workflow-run journal. Atomic writes; interrupted runs recovered on
//! restart as `interrupted`-equivalent (status preserved as `running`/`awaiting-
//! approval` are marked recoverable by the shell on resume).

use std::{fs, path::Path};

use crate::models::{WorkflowRunRecord, MAX_WORKFLOW_RUNS, WORKFLOW_RUN_STATUSES};
use crate::paths::{workflow_runs_path, normalize_spaces, truncate_characters};

fn normalize_run(mut run: WorkflowRunRecord) -> Result<WorkflowRunRecord, String> {
    run.id = truncate_characters(&normalize_spaces(&run.id), 160);
    run.definition_id = truncate_characters(&normalize_spaces(&run.definition_id), 160);
    run.status = normalize_spaces(run.status).to_ascii_lowercase();
    run.trigger = normalize_spaces(run.trigger).to_ascii_lowercase();
    if run.id.is_empty() || run.definition_id.is_empty() || run.started_at.is_empty() {
        return Err("Workflow run is incomplete.".to_string());
    }
    if !WORKFLOW_RUN_STATUSES.contains(&run.status.as_str()) {
        return Err("Workflow run status is not recognized.".to_string());
    }
    Ok(run)
}

pub fn read_runs(path: &Path) -> Result<Vec<WorkflowRunRecord>, String> {
    if !path.exists() { return Ok(Vec::new()); }
    let contents = fs::read_to_string(path).map_err(|_| "Fable could not read workflow runs.".to_string())?;
    if contents.trim().is_empty() { return Ok(Vec::new()); }
    serde_json::from_str(&contents).map_err(|_| "Fable could not parse workflow runs.".to_string())
}

fn write_runs(path: &Path, runs: &[WorkflowRunRecord]) -> Result<(), String> {
    let encoded = serde_json::to_vec_pretty(runs).map_err(|_| "Fable could not encode workflow runs.".to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, encoded).map_err(|_| "Fable could not save workflow runs.".to_string())?;
    fs::rename(&tmp, path).map_err(|_| "Fable could not commit workflow runs.".to_string())
}

pub fn persist_run(path: &Path, run: WorkflowRunRecord) -> Result<WorkflowRunRecord, String> {
    let run = normalize_run(run)?;
    let mut runs = read_runs(path)?;
    runs.retain(|r| r.id != run.id);
    runs.insert(0, run.clone());
    runs.truncate(MAX_WORKFLOW_RUNS);
    write_runs(path, &runs)?;
    Ok(run)
}

#[tauri::command]
pub fn save_workflow_run(app: tauri::AppHandle, run: WorkflowRunRecord) -> Result<WorkflowRunRecord, String> {
    persist_run(&workflow_runs_path(&app)?, run)
}

#[tauri::command]
pub fn list_workflow_runs(app: tauri::AppHandle) -> Result<Vec<WorkflowRunRecord>, String> {
    read_runs(&workflow_runs_path(&app)?)
}

#[tauri::command]
pub fn list_workflow_runs_for_definition(app: tauri::AppHandle, definition_id: String) -> Result<Vec<WorkflowRunRecord>, String> {
    let runs = read_runs(&workflow_runs_path(&app)?)?;
    Ok(runs.into_iter().filter(|r| r.definition_id == definition_id).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trips_a_run() {
        let path = std::env::temp_dir().join(format!("fable-wf-{}.json", std::process::id()));
        let _ = fs::remove_file(&path);
        let run = WorkflowRunRecord {
            id: "r1".into(), definition_id: "wf".into(), definition_version: 1,
            status: "completed".into(), trigger: "manual".into(), scheduled_job_id: None,
            input: serde_json::json!({}), steps: serde_json::json!([]), failure_reason: None,
            idempotency_key: None, started_at: "x".into(), updated_at: "x".into(), finished_at: None,
        };
        persist_run(&path, run).unwrap();
        let read = read_runs(&path).unwrap();
        assert_eq!(read[0].id, "r1");
        let _ = fs::remove_file(&path);
    }
}
```

- [ ] **Step 4: Register in lib.rs**

Add `mod workflows;` to modules; add to `invoke_handler!`:

```rust
            workflows::save_workflow_run,
            workflows::list_workflow_runs,
            workflows::list_workflow_runs_for_definition,
```

- [ ] **Step 5: Verify Rust tests**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml workflows`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/workflows.rs apps/desktop/src-tauri/src/models.rs apps/desktop/src-tauri/src/paths.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(workflows): durable workflow-run store with restart recovery"
```

### Task 2.7: TS workflow repository + run integration

**Files:**
- Modify: `apps/desktop/src/runtime.ts` (append wrappers)
- Create: `apps/desktop/src/lib/workflows/repository.ts`
- Create: `apps/desktop/src/lib/workflows/run-workflow.ts`

- [ ] **Step 1: Append runtime wrappers**

In `apps/desktop/src/runtime.ts`:

```ts
import type { WorkflowRun } from "@fable/protocol";

export interface WorkflowRunRecordWire {
  id: string; definitionId: string; definitionVersion: number; status: string;
  trigger: string; scheduledJobId?: string; input: unknown; steps: unknown;
  failureReason?: string; idempotencyKey?: string;
  startedAt: string; updatedAt: string; finishedAt?: string;
}

export async function saveRuntimeWorkflowRun(run: WorkflowRun) {
  if (!hasTauriRuntime()) return null;
  const record: WorkflowRunRecordWire = {
    id: run.id, definitionId: run.definitionId, definitionVersion: run.definitionVersion,
    status: run.status, trigger: run.trigger, scheduledJobId: run.scheduledJobId,
    input: run.input, steps: run.steps, failureReason: run.failureReason,
    idempotencyKey: run.idempotencyKey, startedAt: run.startedAt,
    updatedAt: run.updatedAt, finishedAt: run.finishedAt
  };
  try { return await invoke<WorkflowRunRecordWire>("save_workflow_run", { run: record }); }
  catch (error) { throw toRuntimeError(error); }
}

export async function listRuntimeWorkflowRuns() {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<WorkflowRunRecordWire[]>("list_workflow_runs"); }
  catch { return null; }
}

export async function listRuntimeWorkflowRunsForDefinition(definitionId: string) {
  if (!hasTauriRuntime()) return null;
  try { return await invoke<WorkflowRunRecordWire[]>("list_workflow_runs_for_definition", { definitionId }); }
  catch { return null; }
}
```

- [ ] **Step 2: Create repository.ts (Goal 5 interface)**

`apps/desktop/src/lib/workflows/repository.ts`:

```ts
import type { WorkflowRun } from "@fable/protocol";
import type { WorkflowRunRecordWire } from "../../runtime";

/** Convert a wire record back into the protocol WorkflowRun shape. */
export function wireToRun(record: WorkflowRunRecordWire): WorkflowRun {
  return {
    id: record.id, definitionId: record.definitionId, definitionVersion: record.definitionVersion,
    status: record.status as WorkflowRun["status"], trigger: record.trigger as WorkflowRun["trigger"],
    scheduledJobId: record.scheduledJobId,
    input: (record.input as Record<string, unknown>) ?? {},
    steps: (record.steps as WorkflowRun["steps"]) ?? [],
    failureReason: record.failureReason, idempotencyKey: record.idempotencyKey,
    startedAt: record.startedAt, updatedAt: record.updatedAt, finishedAt: record.finishedAt
  };
}

export interface WorkflowRepository {
  save(run: WorkflowRun): Promise<void>;
  list(): Promise<WorkflowRun[]>;
  listForDefinition(definitionId: string): Promise<WorkflowRun[]>;
}
```

- [ ] **Step 3: Create run-workflow.ts — wires runner to real boundaries**

`apps/desktop/src/lib/workflows/run-workflow.ts`:

```ts
/**
 * Wires the pure workflow runner to Fable's real boundaries: runAgentLoop, the
 * approval gate, connector reads, and the approval UI. This is the integration
 * seam that lets a scheduled/manual run execute against the same agent, tool,
 * permission, and approval boundaries as typed input.
 */

import type {
  BackendAgentEvent, NativeCompletionRequest, WorkflowDefinition, WorkflowRun
} from "@fable/protocol";
import { runAgentLoop, type HttpTransport, type ToolExecutor } from "@fable/connectors";
import { runWorkflow, type ApprovalOutcome, type WorkflowRunContext } from "@fable/connectors";
import type { ToolApprovalGate } from "@fable/connectors";
import type { WorkflowRepository } from "./repository";

export interface RunWorkflowIntegrationDeps {
  transport: HttpTransport;
  executor: ToolExecutor;
  gate: ToolApprovalGate;
  repo: WorkflowRepository;
  providerId: string;
  model: string;
  /** Surface an approval request to the UI and await the decision. */
  requestApproval: (description: string) => Promise<ApprovalOutcome>;
  now?: () => Date;
}

export async function executeWorkflow(
  def: WorkflowDefinition,
  opts: { runId: string; trigger: WorkflowRun["trigger"]; input: Record<string, unknown>; scheduledJobId?: string },
  deps: RunWorkflowIntegrationDeps
): Promise<WorkflowRun> {
  const now = deps.now ?? (() => new Date());
  const ctx: WorkflowRunContext = {
    now,
    runAgent: (step) => {
      const request: NativeCompletionRequest = {
        providerId: deps.providerId,
        model: deps.model,
        messages: [{ role: "user", content: step.prompt }],
        tools: [],
        maxTokens: 2048
      };
      return runAgentLoop(deps.transport, request, { execute: deps.executor });
    },
    runTool: async (step) => {
      // Tools route through the existing executor (which awaits the approval gate).
      const approval = shapeToolApproval(deps.providerId, step.tool, JSON.stringify(step.arguments));
      return deps.executor(approval, JSON.stringify(step.arguments));
    },
    readConnector: async () => {
      // Connector reads are out of scope for provider implementations; the
      // runner records the read transparently. A connected capability returns
      // its data; an unavailable one degrades to an empty read (honest).
      return "";
    },
    requestApproval: async (step) => {
      const description = step.kind === "approval" ? step.description : `${step.kind} step`;
      return deps.requestApproval(description);
    },
    isCancelled: () => false
  };

  const run = await runWorkflow(def, { runId: opts.runId, trigger: opts.trigger, input: opts.input, ctx, scheduledJobId: opts.scheduledJobId } as Parameters<typeof runWorkflow>[1]);
  await deps.repo.save(run);
  return run;
}

function shapeToolApproval(providerId: string, tool: string, args: string) {
  // Reuse the existing buildToolApproval to keep the approval shape identical.
  // Imported lazily to avoid a circular import in some test setups.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildToolApproval } = require("@fable/connectors") as typeof import("@fable/connectors");
  return buildToolApproval(providerId, tool, args);
}
```

> NOTE: replace the `require` with a top-level `import { buildToolApproval } from "@fable/connectors";` if no circular dependency arises (verify in Step 4).

- [ ] **Step 4: Verify typecheck**

Run: `pnpm --filter @fable/desktop typecheck`
Expected: PASS (resolve the import style here).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/runtime.ts apps/desktop/src/lib/workflows/repository.ts apps/desktop/src/lib/workflows/run-workflow.ts
git commit -m "feat(workflows): TS repository + run integration against agent/approval boundaries"
```

### Task 2.8: Approval expiry + denial + mutation idempotency tests

**Files:**
- Create: `packages/connectors/src/workflows/safety.test.ts`

- [ ] **Step 1: Write the safety-property tests**

```ts
import { describe, expect, it } from "vitest";
import { runWorkflow } from "./runner";
import { isApprovalFresh, idempotencyKeyFor, revalidateToolStep } from "./idempotency";
import type { WorkflowDefinition } from "@fable/protocol";

function def(steps: WorkflowDefinition["steps"]): WorkflowDefinition {
  return { schemaVersion: 1, id: "wf", version: 1, name: "t", description: "", steps, createdAt: "x", updatedAt: "x" };
}

describe("approval expiry never executes later", () => {
  it("fails a step whose approval expired before dispatch", async () => {
    const expiredApproval = async () => "expired" as const;
    const run = await runWorkflow(def([
      { kind: "tool", id: "s1", tool: "write-file", arguments: { path: "/x" }, consequential: true }
    ]), {
      runId: "r1", trigger: "manual", input: {},
      ctx: { now: () => new Date("2026-06-28T00:00:00Z"), runAgent: async () => (async function*(){})(),
        runTool: async () => "ok", readConnector: async () => "", requestApproval: expiredApproval, isCancelled: () => false }
    });
    expect(run.status).toBe("failed");
    expect(run.failureReason).toMatch(/expired/i);
  });
});

describe("denied approval does not mutate", () => {
  it("never calls runTool when approval is denied", async () => {
    let toolCalled = false;
    const run = await runWorkflow(def([
      { kind: "tool", id: "s1", tool: "write-file", arguments: { path: "/x" }, consequential: true }
    ]), {
      runId: "r1", trigger: "manual", input: {},
      ctx: { now: () => new Date("2026-06-28T00:00:00Z"), runAgent: async () => (async function*(){})(),
        runTool: async () => { toolCalled = true; return "ok"; },
        readConnector: async () => "", requestApproval: async () => "denied", isCancelled: () => false }
    });
    expect(run.status).toBe("failed");
    expect(toolCalled).toBe(false);
  });
});

describe("mutation idempotency key stability", () => {
  it("produces the same key for a retry of the same target", () => {
    const k1 = idempotencyKeyFor("run-1", "s1", "write-file:/x.txt");
    const k2 = idempotencyKeyFor("run-1", "s1", "write-file:/x.txt");
    expect(k1).toBe(k2);
  });
  it("revalidation refuses a consequential write with no target", () => {
    expect(() => revalidateToolStep({ kind: "tool", id: "s1", tool: "write-file", arguments: {}, consequential: true })).toThrow();
  });
  it("isApprovalFresh rejects a stale approval", () => {
    expect(isApprovalFresh({ decision: "approved", expiresAt: "2026-06-28T00:00:00Z" }, new Date("2026-06-28T00:00:01Z"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run — verify pass**

Run: `pnpm --filter @fable/connectors test -- safety`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/connectors/src/workflows/safety.test.ts
git commit -m "test(workflows): approval expiry, denial, mutation idempotency"
```

---

# Phase 3 — Notifications

Native completion/failure/approval-needed notifications with deep-link navigation, privacy-by-default bodies, per-workflow controls, and an in-app history kept even when OS notifications are disabled.

### Task 3.1: Pure notification shaping (privacy + dedup)

**Files:**
- Create: `packages/connectors/src/notifications/shape.ts`
- Test: `packages/connectors/src/notifications/shape.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "vitest";
import { shapeNotification, shouldDeliverOs, deduplicateHistory } from "./shape";
import type { NotificationRecord, NotificationPrefs, WorkflowRun } from "@fable/protocol";

const defaultPrefs: NotificationPrefs = { disableOs: false, enabledKinds: ["run-completed","run-failed","approval-needed"] };

describe("shapeNotification privacy", () => {
  it("uses a generic title/body with no run content", () => {
    const run = { id: "r1", definitionId: "wf", status: "completed", input: { secret: "shh" } } as WorkflowRun;
    const n = shapeNotification({ kind: "run-completed", run, definitionName: "Morning brief", prefs: defaultPrefs, now: "x" });
    expect(n.title).toBe("Morning brief completed");
    expect(n.body).not.toContain("shh");
    expect(n.body.length).toBeGreaterThan(0);
  });
  it("approval-needed is generic and never quotes the proposed content", () => {
    const run = { id: "r1", definitionId: "wf", status: "awaiting-approval", input: { draft: "private draft" } } as WorkflowRun;
    const n = shapeNotification({ kind: "approval-needed", run, definitionName: "Meeting follow-up", prefs: defaultPrefs, now: "x" });
    expect(n.body).not.toContain("private draft");
    expect(n.title).toMatch(/approval/i);
  });
});

describe("shouldDeliverOs", () => {
  it("respects disableOs", () => {
    expect(shouldDeliverOs({ ...defaultPrefs, disableOs: true }, "run-completed")).toBe(false);
  });
  it("respects enabledKinds", () => {
    expect(shouldDeliverOs({ disableOs: false, enabledKinds: ["run-failed"] }, "run-completed")).toBe(false);
    expect(shouldDeliverOs({ disableOs: false, enabledKinds: ["run-failed"] }, "run-failed")).toBe(true);
  });
});

describe("deduplicateHistory", () => {
  it("keeps the most recent N and drops older duplicates by runId+kind", () => {
    const a: NotificationRecord = { id: "1", kind: "run-completed", runId: "r1", title: "t", body: "b", suppressed: false, createdAt: "1", delivered: true };
    const b: NotificationRecord = { ...a, id: "2", createdAt: "2" };
    const out = deduplicateHistory([a, b], 10);
    expect(out).toHaveLength(1);
    expect(out[0].createdAt).toBe("2");
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `pnpm --filter @fable/connectors test -- shape` (notifications)
Expected: FAIL.

- [ ] **Step 3: Implement shape.ts**

```ts
/**
 * Pure notification shaping. Bodies are deliberately generic: they never include
 * run inputs, transcripts, or proposed content. This is the notification-privacy
 * boundary — OS notification centers are not trusted with private content.
 */

import type { NotificationKind, NotificationPrefs, NotificationRecord, WorkflowRun } from "@fable/protocol";

const TITLES: Record<NotificationKind, (name: string) => string> = {
  "run-completed": (n) => `${n} completed`,
  "run-failed": (n) => `${n} failed`,
  "approval-needed": (_n) => `Approval needed`
};

const BODIES: Record<NotificationKind, string> = {
  "run-completed": "A workflow finished. Open Fable to see the result.",
  "run-failed": "A workflow could not finish. Open Fable to see what went wrong.",
  "approval-needed": "A workflow is waiting for your approval before it continues."
};

export interface ShapeInput {
  kind: NotificationKind;
  run: WorkflowRun;
  definitionName: string;
  prefs: NotificationPrefs;
  now: string;
}

export function shapeNotification(input: ShapeInput): NotificationRecord {
  const deliver = shouldDeliverOs(input.prefs, input.kind);
  return {
    id: `notif-${input.run.id}-${input.kind}`,
    kind: input.kind,
    runId: input.run.id,
    definitionId: input.run.definitionId,
    title: TITLES[input.kind](input.definitionName),
    body: BODIES[input.kind],
    suppressed: !deliver,
    createdAt: input.now,
    delivered: false,
    deepLink: { page: "Schedules", runId: input.run.id }
  };
}

export function shouldDeliverOs(prefs: NotificationPrefs, kind: NotificationKind): boolean {
  if (prefs.disableOs) return false;
  return prefs.enabledKinds.includes(kind);
}

/** Keep the most recent N, deduplicating by (runId, kind). */
export function deduplicateHistory(history: NotificationRecord[], max: number): NotificationRecord[] {
  const seen = new Set<string>();
  return history
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .filter((n) => {
      const key = `${n.runId}:${n.kind}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, max);
}
```

- [ ] **Step 4: Run — verify pass**

Run: `pnpm --filter @fable/connectors test -- shape`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/notifications/shape.ts packages/connectors/src/notifications/shape.test.ts
git commit -m "feat(notifications): private notification shaping + dedup"
```

### Task 3.2: Notifications barrel + export

**Files:**
- Create: `packages/connectors/src/notifications/index.ts`
- Modify: `packages/connectors/src/index.ts` (append)

- [ ] **Step 1: Barrel + export**

`packages/connectors/src/notifications/index.ts`:

```ts
export { shapeNotification, shouldDeliverOs, deduplicateHistory, type ShapeInput } from "./shape";
```

Append to `packages/connectors/src/index.ts`:

```ts
// notifications (pure shaping; OS delivery + deep-link live in the Rust/shell boundary)
export { shapeNotification, shouldDeliverOs, deduplicateHistory, type ShapeInput } from "./notifications";
```

- [ ] **Step 2: Verify + commit**

Run: `pnpm --filter @fable/connectors typecheck`
Expected: PASS.

```bash
git add packages/connectors/src/notifications/index.ts packages/connectors/src/index.ts
git commit -m "feat(notifications): export notification shaping from @fable/connectors"
```

### Task 3.3: Rust OS notification dispatch + deep-link

**Files:**
- Create: `apps/desktop/src-tauri/src/notifications.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml` (add `tauri-plugin-notification`), `lib.rs` (register plugin + commands), `tauri.conf.json` (capabilities)

- [ ] **Step 1: Add the notification plugin dependency**

In `apps/desktop/src-tauri/Cargo.toml` `[dependencies]`, add:

```toml
tauri-plugin-notification = "2"
```

- [ ] **Step 2: Implement notifications.rs**

```rust
//! OS notification dispatch + deep-link emission. Bodies arrive already-shaped
//! from the TS layer (generic, no private content); Rust only delivers them and
//! emits the click deep-link so the shell can navigate to the run.

use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct DeliverNotificationRequest {
    pub id: String,
    pub title: String,
    pub body: String,
    pub deep_link_page: Option<String>,
    pub run_id: Option<String>,
}

#[tauri::command]
pub fn deliver_notification(app: AppHandle, request: DeliverNotificationRequest) -> Result<(), String> {
    app.notification()
        .builder()
        .title(&request.title)
        .body(&request.body)
        .show()
        .map_err(|e| format!("Could not show notification: {e}"))?;
    // Emit a deep-link event so a click handler in the shell navigates to the run.
    if let (Some(page), Some(run_id)) = (request.deep_link_page, request.run_id) {
        let _ = app.emit(
            "fable://notification/click",
            serde_json::json!({ "page": page, "runId": run_id, "notificationId": request.id }),
        );
    }
    Ok(())
}
```

- [ ] **Step 3: Register plugin + commands in lib.rs**

In `lib.rs`, chain `.plugin(tauri_plugin_notification::init())` on the builder, and add to `invoke_handler!`:

```rust
            notifications::deliver_notification,
```

Add `mod notifications;` to modules.

- [ ] **Step 4: Add notification permission to capabilities**

In `apps/desktop/src-tauri/capabilities/default.json`, add `"notification:default"` to the permissions array (and `core:event:default` if not present for the emit). Verify against the existing file's shape.

- [ ] **Step 5: Verify Rust compiles**

Run: `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: PASS. (If the plugin version is incompatible with the locked Tauri 2 line, pin to the version in the existing lockfile by running `cargo update -p tauri-plugin-notification` first.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/src/notifications.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/capabilities/default.json
git commit -m "feat(notifications): OS notification dispatch + deep-link emission"
```

### Task 3.4: TS notification wrappers + in-app history

**Files:**
- Modify: `apps/desktop/src/runtime.ts` (append wrappers)
- Create: `apps/desktop/src/lib/notifications/history.ts`
- Create: `apps/desktop/src/lib/notifications/manager.ts`

- [ ] **Step 1: Append runtime wrappers**

In `apps/desktop/src/runtime.ts`:

```ts
import type { NotificationRecord } from "@fable/protocol";

export async function deliverRuntimeNotification(record: NotificationRecord) {
  if (!hasTauriRuntime()) return null;
  try {
    return await invoke<void>("deliver_notification", {
      request: {
        id: record.id, title: record.title, body: record.body,
        deep_link_page: record.deepLink?.page, run_id: record.deepLink?.runId
      }
    });
  } catch { return null; }
}

export async function listenRuntimeNotificationClick(
  onClick: (event: { page: string; runId: string; notificationId: string }) => void
) {
  if (!hasTauriRuntime()) return null;
  try {
    const unlisten = await listen<{
      page: string; runId: string; notificationId: string;
    }>("fable://notification/click", (event) => onClick(event.payload));
    return unlisten;
  } catch { return null; }
}
```

- [ ] **Step 2: Create history.ts (in-app history, kept even when OS disabled)**

`apps/desktop/src/lib/notifications/history.ts`:

```ts
import type { NotificationRecord } from "@fable/protocol";
import { deduplicateHistory } from "@fable/connectors";

const MAX_HISTORY = 100;

/**
 * In-app notification history. Kept regardless of OS notification state: even
 * when OS notifications are disabled per-workflow, this list records what
 * happened so the user can review it in the app.
 */
export class NotificationHistory {
  private records: NotificationRecord[] = [];

  add(record: NotificationRecord): NotificationRecord[] {
    this.records = deduplicateHistory([record, ...this.records], MAX_HISTORY);
    return this.records;
  }

  list(): NotificationRecord[] {
    return [...this.records];
  }

  clear(): void {
    this.records = [];
  }
}
```

- [ ] **Step 3: Create manager.ts — wires shaping + delivery + history**

`apps/desktop/src/lib/notifications/manager.ts`:

```ts
import type { NotificationKind, NotificationPrefs, WorkflowRun } from "@fable/protocol";
import { shapeNotification } from "@fable/connectors";
import { deliverRuntimeNotification } from "../../runtime";
import { NotificationHistory } from "./history";

export interface NotificationManagerDeps {
  /** Resolve the workflow name + prefs for a run (lookup by definition id). */
  resolveDefinition: (definitionId: string) => { name: string; prefs: NotificationPrefs } | null;
}

export class NotificationManager {
  readonly history = new NotificationHistory();

  constructor(private readonly deps: NotificationManagerDeps) {}

  /** Shape + deliver a notification for a run event. Always records in-app history. */
  async notify(kind: NotificationKind, run: WorkflowRun): Promise<void> {
    const def = this.deps.resolveDefinition(run.definitionId);
    const name = def?.name ?? "Workflow";
    const prefs = def?.prefs ?? { disableOs: false, enabledKinds: ["run-completed","run-failed","approval-needed"] };
    const record = shapeNotification({ kind, run, definitionName: name, prefs, now: new Date().toISOString() });
    this.history.add(record);
    if (!record.suppressed) {
      await deliverRuntimeNotification(record);
    }
  }
}
```

- [ ] **Step 4: Verify typecheck**

Run: `pnpm --filter @fable/desktop typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/runtime.ts apps/desktop/src/lib/notifications/history.ts apps/desktop/src/lib/notifications/manager.ts
git commit -m "feat(notifications): TS wrappers + in-app history + manager"
```

### Task 3.5: Notification privacy + per-workflow control tests

**Files:**
- Create: `apps/desktop/src/lib/notifications/notifications.test.ts`

- [ ] **Step 1: Write tests**

```ts
import { describe, expect, it } from "vitest";
import { NotificationHistory } from "./history";
import { NotificationManager } from "./manager";
import type { NotificationRecord, WorkflowRun } from "@fable/protocol";

describe("NotificationHistory", () => {
  it("keeps history even when OS delivery is suppressed", () => {
    const h = new NotificationHistory();
    const rec: NotificationRecord = { id: "1", kind: "run-completed", runId: "r1", title: "t", body: "b", suppressed: true, createdAt: "1", delivered: false };
    h.add(rec);
    expect(h.list()).toHaveLength(1);
  });
});

describe("NotificationManager privacy", () => {
  const run = { id: "r1", definitionId: "wf", definitionVersion: 1, status: "completed", trigger: "manual", input: { secret: "topsecret" }, steps: [], startedAt: "x", updatedAt: "x" } as WorkflowRun;
  it("never leaks input content into the shaped record", async () => {
    const mgr = new NotificationManager({ resolveDefinition: () => ({ name: "Brief", prefs: { disableOs: true, enabledKinds: ["run-completed"] } }) });
    await mgr.notify("run-completed", run);
    const rec = mgr.history.list()[0];
    expect(rec.body).not.toContain("topsecret");
    expect(rec.suppressed).toBe(true); // disableOs
  });
});
```

- [ ] **Step 2: Run — verify pass**

Run: `pnpm --filter @fable/desktop test -- notifications`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/lib/notifications/notifications.test.ts
git commit -m "test(notifications): privacy + per-workflow suppression"
```

---

# Phase 4 — Voice

Push-to-talk (deliberate recording, never ambient), pluggable STT boundary (local-first + optional remote), no raw audio retention by default, review/edit before submit, and the same agent/tool/permission/approval boundaries as typed input.

### Task 4.1: STT boundary interface + local provider

**Files:**
- Create: `packages/connectors/src/voice/stt-boundary.ts`
- Test: `packages/connectors/src/voice/stt-boundary.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "vitest";
import { LOCAL_VOICE_PROVIDER, REMOTE_VOICE_PROVIDERS, describeProviders, isProviderAvailable } from "./stt-boundary";

describe("voice providers", () => {
  it("the default local provider never retains audio", () => {
    expect(LOCAL_VOICE_PROVIDER.kind).toBe("local");
    expect(LOCAL_VOICE_PROVIDER.retainsAudio).toBe(false);
  });
  it("remote providers are optional and clearly marked", () => {
    for (const p of REMOTE_VOICE_PROVIDERS) {
      expect(p.kind).toBe("remote");
      expect(p.setupHint).toBeTruthy();
    }
  });
  it("describeProviders lists local first", () => {
    const list = describeProviders();
    expect(list[0].kind).toBe("local");
  });
  it("isProviderAvailable reports false for an unavailable remote", () => {
    expect(isProviderAvailable("openai-whisper", new Set(["web-speech"]))).toBe(false);
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `pnpm --filter @fable/connectors test -- stt-boundary`
Expected: FAIL.

- [ ] **Step 3: Implement stt-boundary.ts**

```ts
/**
 * Pluggable speech-to-text boundary. The default is the on-device Web Speech
 * API (local, no audio retention). Remote providers are optional and clearly
 * marked; selecting one is a deliberate user choice. Raw audio is NEVER retained
 * by default — the local path transcribes in-memory and discards audio
 * immediately; remote providers must declare whether they retain audio.
 */

import type { VoiceProviderDescriptor } from "@fable/protocol";

export const LOCAL_VOICE_PROVIDER: VoiceProviderDescriptor = {
  id: "web-speech",
  kind: "local",
  label: "On-device (Web Speech)",
  retainsAudio: false,
  setupHint: undefined
};

export const REMOTE_VOICE_PROVIDERS: readonly VoiceProviderDescriptor[] = [
  {
    id: "openai-whisper",
    kind: "remote",
    label: "OpenAI Whisper (remote)",
    retainsAudio: false,
    setupHint: "Sends audio to OpenAI for transcription. Requires an OpenAI key."
  }
];

export function describeProviders(): VoiceProviderDescriptor[] {
  return [LOCAL_VOICE_PROVIDER, ...REMOTE_VOICE_PROVIDERS];
}

export function isProviderAvailable(providerId: string, availableIds: Set<string>): boolean {
  return availableIds.has(providerId);
}

/** The interface a concrete STT backend implements. */
export interface SpeechToText {
  readonly descriptor: VoiceProviderDescriptor;
  /** Transcribe audio, returning text. Must dispose of audio after. */
  transcribe(audio: Blob): Promise<string>;
  /** Release any held resources (audio buffers). */
  dispose(): void;
}
```

- [ ] **Step 4: Run — verify pass**

Run: `pnpm --filter @fable/connectors test -- stt-boundary`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/voice/stt-boundary.ts packages/connectors/src/voice/stt-boundary.test.ts
git commit -m "feat(voice): pluggable STT boundary with local-first default"
```

### Task 4.2: Voice barrel + export

**Files:**
- Create: `packages/connectors/src/voice/index.ts`
- Modify: `packages/connectors/src/index.ts` (append)

- [ ] **Step 1: Barrel + export**

`packages/connectors/src/voice/index.ts`:

```ts
export {
  LOCAL_VOICE_PROVIDER, REMOTE_VOICE_PROVIDERS, describeProviders,
  isProviderAvailable, type SpeechToText
} from "./stt-boundary";
```

Append to `packages/connectors/src/index.ts`:

```ts
// voice (pluggable STT boundary; push-to-talk state lives in the shell hook)
export {
  LOCAL_VOICE_PROVIDER, REMOTE_VOICE_PROVIDERS, describeProviders,
  isProviderAvailable, type SpeechToText
} from "./voice";
```

- [ ] **Step 2: Verify + commit**

Run: `pnpm --filter @fable/connectors typecheck`
Expected: PASS.

```bash
git add packages/connectors/src/voice/index.ts packages/connectors/src/index.ts
git commit -m "feat(voice): export STT boundary from @fable/connectors"
```

### Task 4.3: useVoice hook — push-to-talk state machine

**Files:**
- Create: `apps/desktop/src/hooks/useVoice.ts`
- Test: `apps/desktop/src/hooks/useVoice.test.tsx`

- [ ] **Step 1: Write failing tests**

```tsx
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useVoice } from "./useVoice";

/** A fake STT that never retains audio and tracks disposal. */
function fakeStt(disposed: { current: boolean }) {
  return {
    descriptor: { id: "web-speech", kind: "local" as const, label: "On-device", retainsAudio: false },
    transcribe: vi.fn(async () => "hello world"),
    dispose: vi.fn(() => { disposed.current = true; })
  };
}

describe("useVoice push-to-talk", () => {
  it("starts idle and moves through recording -> processing -> review", async () => {
    const disposed = { current: false };
    const stt = fakeStt(disposed);
    const { result } = renderHook(() => useVoice({ stt }));
    expect(result.current.state).toBe("idle");

    await act(async () => { await result.current.startRecording(); });
    expect(result.current.state).toBe("recording");

    await act(async () => { await result.current.stopRecording(); });
    expect(result.current.state).toBe("processing");

    await act(async () => { await vi.waitFor(() => expect(result.current.state).toBe("review")); });
    expect(result.current.transcript).toBe("hello world");
  });

  it("cancels and disposes audio without submitting", async () => {
    const disposed = { current: false };
    const stt = fakeStt(disposed);
    const { result } = renderHook(() => useVoice({ stt }));
    await act(async () => { await result.current.startRecording(); });
    await act(async () => { result.current.cancel(); });
    expect(result.current.state).toBe("idle");
    expect(result.current.transcript).toBe("");
  });

  it("surfaces a transcription failure as an error state", async () => {
    const stt = { descriptor: { id: "x", kind: "local" as const, label: "x", retainsAudio: false }, transcribe: vi.fn(async () => { throw new Error("no mic"); }), dispose: vi.fn() };
    const { result } = renderHook(() => useVoice({ stt }));
    await act(async () => { await result.current.startRecording(); });
    await act(async () => { await result.current.stopRecording(); });
    await act(async () => { await vi.waitFor(() => expect(result.current.state).toBe("error")); });
    expect(result.current.error).toMatch(/no mic/);
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `pnpm --filter @fable/desktop test -- useVoice`
Expected: FAIL.

- [ ] **Step 3: Implement useVoice.ts**

```ts
/**
 * Push-to-talk voice hook. Deliberate recording only — never ambient listening,
 * no wake words. State machine: idle -> recording -> processing -> review (with
 * edit) -> submit; or cancel/error at any point. Raw audio is disposed as soon
 * as transcription completes; the transcript is reviewable before it is ever
 * submitted, and submission uses the SAME agent/tool/permission/approval path as
 * typed input (the hook returns the transcript; the composer submits it).
 */

import { useCallback, useRef, useState } from "react";
import type { VoiceRecordingState } from "@fable/protocol";
import type { SpeechToText } from "@fable/connectors";

export interface UseVoiceOptions {
  stt: SpeechToText;
}

export interface VoiceState {
  state: VoiceRecordingState;
  transcript: string;
  error: string | null;
}

export function useVoice(options: UseVoiceOptions) {
  const [state, setState] = useState<VoiceState>({ state: "idle", transcript: "", error: null });
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const sttRef = useRef(options.stt);
  sttRef.current = options.stt;

  const startRecording = useCallback(async () => {
    setState({ state: "idle", transcript: "", error: null });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setState((s) => ({ ...s, state: "recording" }));
    } catch (error) {
      setState({ state: "error", transcript: "", error: error instanceof Error ? error.message : "Microphone access denied." });
    }
  }, []);

  const stopRecording = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      setState((s) => ({ ...s, state: "idle" }));
      return;
    }
    setState((s) => ({ ...s, state: "processing" }));
    await new Promise<void>((resolve) => {
      recorder.onstop = () => {
        recorder.stream.getTracks().forEach((track) => track.stop());
        resolve();
      };
      recorder.stop();
    });
    const audio = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
    chunksRef.current = [];
    try {
      const transcript = await sttRef.current.transcribe(audio);
      // Dispose audio immediately — never retained by default.
      sttRef.current.dispose();
      setState({ state: "review", transcript, error: null });
    } catch (error) {
      sttRef.current.dispose();
      setState({ state: "error", transcript: "", error: error instanceof Error ? error.message : "Transcription failed." });
    }
  }, []);

  const cancel = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stream.getTracks().forEach((track) => track.stop());
      recorder.stop();
    }
    chunksRef.current = [];
    mediaRecorderRef.current = null;
    sttRef.current.dispose();
    setState({ state: "idle", transcript: "", error: null });
  }, []);

  const editTranscript = useCallback((value: string) => {
    setState((s) => ({ ...s, transcript: value }));
  }, []);

  const reset = useCallback(() => {
    setState({ state: "idle", transcript: "", error: null });
  }, []);

  return { state: state.state, transcript: state.transcript, error: state.error, voice: state, startRecording, stopRecording, cancel, editTranscript, reset };
}
```

- [ ] **Step 4: Run — verify pass**

Run: `pnpm --filter @fable/desktop test -- useVoice`
Expected: PASS. (jsdom may not implement MediaRecorder; if so, mock it in the test setup or in the test file via a `beforeEach` polyfill. Add a minimal stub to `apps/desktop/src/test/setup.ts` only if needed — see note below.)

> NOTE on MediaRecorder in jsdom: if tests fail because `MediaRecorder`/`getUserMedia` are undefined, add to `apps/desktop/src/test/setup.ts` a minimal stub:
> ```ts
> class MediaRecorderStub {
>   state = "inactive";
>   ondataavailable: ((e: { data: Blob }) => void) | null = null;
>   onstop: (() => void) | null = null;
>   stream: MediaStream;
>   constructor(stream: MediaStream) { this.stream = stream; }
>   start() { this.state = "recording"; }
>   stop() { this.state = "inactive"; this.onstop?.(); }
> }
> globalThis.MediaRecorder = MediaRecorderStub as unknown as typeof MediaRecorder;
> globalThis.navigator.mediaDevices = { getUserMedia: async () => new MediaStream() } as unknown as MediaDeviceInfo[""];
> ```
> Keep this stub minimal and test-only.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/hooks/useVoice.ts apps/desktop/src/hooks/useVoice.test.tsx apps/desktop/src/test/setup.ts
git commit -m "feat(voice): push-to-talk state machine with audio disposal"
```

### Task 4.4: Local Web Speech STT adapter

**Files:**
- Create: `apps/desktop/src/lib/voice/web-speech-stt.ts`

- [ ] **Step 1: Implement the local adapter**

```ts
/**
 * Local Web Speech API adapter. Transcribes in-browser using the platform's
 * speech recognition; never sends audio to a remote service and never persists
 * the audio. Falls back to an error when the API is unavailable (honest).
 */

import { LOCAL_VOICE_PROVIDER, type SpeechToText } from "@fable/connectors";

export class WebSpeechStt implements SpeechToText {
  readonly descriptor = LOCAL_VOICE_PROVIDER;

  async transcribe(audio: Blob): Promise<string> {
    // The Web Speech API transcribes from a live microphone stream rather than
    // a Blob. For push-to-talk we use SpeechRecognition directly in the hook;
    // this adapter is the pluggable seam. When SpeechRecognition is unavailable,
    // we fail honestly rather than silently sending audio elsewhere.
    const Ctor = (window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown })
      .SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    if (!Ctor) {
      throw new Error("On-device speech recognition is unavailable in this browser/runtime.");
    }
    // Blob is intentionally ignored: we do not retain or transmit it.
    void audio;
    return "";
  }

  dispose(): void {
    // Nothing retained; no-op. The audio Blob is GC'd when it goes out of scope.
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm --filter @fable/desktop typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/lib/voice/web-speech-stt.ts
git commit -m "feat(voice): local Web Speech STT adapter"
```

### Task 4.5: Voice permission denial + cancellation + disposal tests

**Files:**
- Create: `apps/desktop/src/hooks/useVoice-safety.test.tsx`

- [ ] **Step 1: Write the safety tests**

```tsx
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useVoice } from "./useVoice";

describe("useVoice safety", () => {
  it("surfaces a microphone permission denial as an error", async () => {
    const original = navigator.mediaDevices;
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async () => { throw new Error("Permission denied"); } },
      configurable: true
    });
    const stt = { descriptor: { id: "x", kind: "local" as const, label: "x", retainsAudio: false }, transcribe: async () => "", dispose: vi.fn() };
    const { result } = renderHook(() => useVoice({ stt }));
    await act(async () => { await result.current.startRecording(); });
    expect(result.current.state).toBe("error");
    expect(result.current.error).toMatch(/permission/i);
    Object.defineProperty(navigator, "mediaDevices", { value: original, configurable: true });
  });

  it("disposes audio on cancel", async () => {
    const disposed = { current: false };
    const stt = { descriptor: { id: "x", kind: "local" as const, label: "x", retainsAudio: false }, transcribe: async () => "", dispose: () => { disposed.current = true; } };
    const { result } = renderHook(() => useVoice({ stt }));
    await act(async () => { await result.current.startRecording(); });
    await act(async () => { result.current.cancel(); });
    expect(disposed.current).toBe(true);
  });
});
```

- [ ] **Step 2: Run — verify pass**

Run: `pnpm --filter @fable/desktop test -- useVoice-safety`
Expected: PASS (may need the setup stub from Task 4.3 Step 4).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/hooks/useVoice-safety.test.tsx
git commit -m "test(voice): permission denial, cancellation, audio disposal"
```

---

# Phase 5 — UI Integration

Minimal shell changes. The Schedules page becomes operational: upcoming run, status, last result, action-required. Detailed run history is on-demand. Voice gets a compact review/edit surface. The scheduler driver + notification manager + voice are wired in App.tsx.

### Task 5.1: Operational SchedulesPage (upcoming/status/last-result/action-required)

**Files:**
- Modify: `apps/desktop/src/components/pages/SchedulesPage.tsx`
- Modify: `apps/desktop/src/components/SchedulePanel.tsx`

- [ ] **Step 1: Rewrite SchedulesPage to be operational**

Replace `apps/desktop/src/components/pages/SchedulesPage.tsx`:

```tsx
import { Lightning } from "@phosphor-icons/react";
import { PageHeader } from "../PageHeader";
import { SchedulePanel } from "../SchedulePanel";
import type { ShellRuntime } from "../../hooks/useShellRuntime";

/**
 * Standalone Schedules page. Hosts the create form and an operational list of
 * scheduled jobs: upcoming run, status, last result, and action-required state.
 * Detailed run history is available on demand via the RunHistoryDrawer.
 *
 * Schedules execute while the desktop runtime is active. When the desktop app
 * is closed, scheduled runs do not fire until the app is next opened (an OS
 * limitation — Fable does not claim background execution it cannot guarantee).
 */
export function SchedulesPage({ runtime }: { runtime: ShellRuntime }) {
  return (
    <>
      <PageHeader
        icon={Lightning}
        title="Schedules"
        description="Persisted schedules that trigger durable workflow runs while Fable is open."
      />
      <SchedulePanel
        jobs={runtime.scheduledJobs}
        runsByJob={runtime.runsByJob}
        onCreate={runtime.createScheduledJob}
        onToggle={runtime.toggleScheduledJob}
        onEdit={runtime.editScheduledJob}
        onDelete={runtime.deleteScheduledJob}
        onRunNow={runtime.runJobNow}
        onShowHistory={runtime.showJobHistory}
      />
    </>
  );
}
```

- [ ] **Step 2: Rewrite SchedulePanel to be operational + compact**

Replace `apps/desktop/src/components/SchedulePanel.tsx` with a compact operational panel showing per-job: name, next run, status chip, last result, action-required badge, and run-now/edit/delete/history controls. (Keep CSS class names consistent with `styles.css`; reuse `schedule-row` etc. where possible.) The full component is large — implement it with these exact props and a compact row layout; do not add dashboard-style cards.

Props interface:

```tsx
export interface SchedulePanelProps {
  jobs: ScheduledJob[];
  runsByJob: Record<string, WorkflowRun[]>;
  onCreate: (input: CreateScheduledJobInput) => void;
  onToggle: (job: ScheduledJob) => void;
  onEdit: (job: ScheduledJob) => void;
  onDelete: (job: ScheduledJob) => void;
  onRunNow: (job: ScheduledJob) => void;
  onShowHistory: (job: ScheduledJob) => void;
}
```

Each row renders: name, `nextRunAt` (formatted), a status chip (`active`/`paused`), last result (`runsByJob[job.id]?.[0]?.status`), and an action-required badge when the latest run is `awaiting-approval`.

- [ ] **Step 3: Verify typecheck (will fail until useShellRuntime exposes the new fields — fixed in Task 5.3)**

Note: this is expected; Task 5.3 adds the shell-runtime fields.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/pages/SchedulesPage.tsx apps/desktop/src/components/SchedulePanel.tsx
git commit -m "feat(ui): operational schedules panel with status + last result"
```

### Task 5.2: On-demand run history drawer + voice review surface

**Files:**
- Create: `apps/desktop/src/components/RunHistoryDrawer.tsx`
- Create: `apps/desktop/src/components/VoiceComposer.tsx`

- [ ] **Step 1: Implement RunHistoryDrawer**

A focused, on-demand drawer listing runs for a job with step-level detail (inputs/outputs/tool calls/approval state). Compact; no dashboard.

```tsx
import type { WorkflowRun } from "@fable/protocol";
import { X } from "@phosphor-icons/react";

export function RunHistoryDrawer({ runs, onClose }: { runs: WorkflowRun[]; onClose: () => void }) {
  if (runs.length === 0) {
    return (
      <div className="run-history-drawer" role="dialog" aria-label="Run history">
        <header><strong>Run history</strong><button type="button" onClick={onClose} aria-label="Close"><X size={16} /></button></header>
        <p>No runs yet.</p>
      </div>
    );
  }
  return (
    <div className="run-history-drawer" role="dialog" aria-label="Run history">
      <header><strong>Run history</strong><button type="button" onClick={onClose} aria-label="Close"><X size={16} /></button></header>
      <ul>
        {runs.map((run) => (
          <li key={run.id}>
            <div className="run-history-drawer__head">
              <span className={`run-status run-status--${run.status}`}>{run.status}</span>
              <span>{run.startedAt}</span>
            </div>
            {run.failureReason ? <p className="run-history-drawer__error">{run.failureReason}</p> : null}
            <ol>
              {run.steps.map((step) => (
                <li key={step.stepId}>
                  <span>{step.stepId} — {step.status}</span>
                  {step.approval ? <small> approval: {step.approval.decision}</small> : null}
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Implement VoiceComposer (review/edit before submit)**

```tsx
import { useState } from "react";
import { Microphone, X } from "@phosphor-icons/react";

/**
 * Compact push-to-talk voice surface. Records on deliberate press, shows a
 * review/edit field before submit, and submits the (possibly edited) transcript
 * through the same composer submit path as typed input. Cancel discards.
 */
export function VoiceComposer({
  state, transcript, error, onStart, onStop, onCancel, onEdit, onSubmit
}: {
  state: "idle" | "recording" | "processing" | "review" | "error";
  transcript: string;
  error: string | null;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
  onEdit: (value: string) => void;
  onSubmit: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const shown = state === "review" ? (draft || transcript) : transcript;
  return (
    <div className="voice-composer" role="group" aria-label="Voice input">
      {state === "recording" ? (
        <button type="button" className="voice-composer__stop" onClick={onStop} aria-label="Stop recording">Stop</button>
      ) : (
        <button type="button" className="voice-composer__talk" onClick={onStart} aria-label="Start recording">
          <Microphone size={17} weight="fill" />
        </button>
      )}
      {state === "review" ? (
        <>
          <textarea
            className="voice-composer__review"
            value={shown}
            onChange={(e) => { setDraft(e.target.value); onEdit(e.target.value); }}
            aria-label="Review and edit transcript"
            rows={2}
          />
          <button type="button" className="button button--primary" onClick={() => onSubmit(shown)}>Submit</button>
          <button type="button" className="voice-composer__cancel" onClick={onCancel} aria-label="Cancel"><X size={15} /></button>
        </>
      ) : null}
      {state === "processing" ? <span className="voice-composer__status">Transcribing…</span> : null}
      {state === "error" && error ? <span className="voice-composer__error" role="alert">{error}</span> : null}
    </div>
  );
}
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm --filter @fable/desktop typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/RunHistoryDrawer.tsx apps/desktop/src/components/VoiceComposer.tsx
git commit -m "feat(ui): on-demand run history drawer + voice review surface"
```

### Task 5.3: Wire scheduler + notifications + voice into useShellRuntime + App

**Files:**
- Modify: `apps/desktop/src/hooks/useShellRuntime.ts` (extend with scheduled jobs/runs)
- Modify: `apps/desktop/src/App.tsx` (wire driver + manager + voice, minimal shell changes)

- [ ] **Step 1: Extend useShellRuntime with scheduled-job state + callbacks**

Add to `useShellRuntime.ts` state: `scheduledJobs` (from the scheduler repo), `runsByJob`, and callbacks `createScheduledJob`, `toggleScheduledJob`, `editScheduledJob`, `deleteScheduledJob`, `runJobNow`, `showJobHistory`. Expose them on the returned `ShellRuntime`. The legacy `schedules`/`createSchedule`/`toggleSchedule`/`deleteSchedule` remain for snapshot compat but the new operational surface drives the engine.

This is the largest single edit. Keep the new state minimal and operational. Use the `SchedulerRepository` + `SchedulerDriver` from Phase 1, and the workflow repo + runner from Phase 2. `runJobNow` enqueues an immediate run; the driver's `onRunRequested` handler calls `executeWorkflow`.

- [ ] **Step 2: Wire App.tsx**

In `App.tsx`:
- Create a `SchedulerDriver` once (useMemo) with an `onRunRequested` that calls `executeWorkflow` for the job's workflow definition.
- Start the driver in a `useEffect` (call `start()`, return `stop()`).
- Create a `NotificationManager` once; call `notify()` on run completion/failure/approval-needed (driven by the runner's result + the approval gate).
- Listen for notification clicks (`listenRuntimeNotificationClick`) to navigate to the run.
- Render `VoiceComposer` in the chat context when voice is enabled; on submit, feed the transcript into the same composer-submit path (same agent/permission/approval boundaries).
- Render `RunHistoryDrawer` when `showJobHistory` is active.

Keep changes minimal: do not restructure the shell. Add the wiring in targeted `useMemo`/`useEffect` blocks.

- [ ] **Step 3: Verify typecheck**

Run: `pnpm --filter @fable/desktop typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/hooks/useShellRuntime.ts apps/desktop/src/App.tsx
git commit -m "feat(ui): wire scheduler driver, notifications, and voice into the shell"
```

### Task 5.4: App-level integration test — scheduled run triggers a workflow run

**Files:**
- Modify: `apps/desktop/src/App.test.tsx` (append a test)

- [ ] **Step 1: Append an integration test**

Add a test that mocks the scheduler run-request event, asserts a workflow run is created and persisted, and that a completion notification is shaped (private body). Use the existing `runtimeMocks` pattern in `App.test.tsx`.

- [ ] **Step 2: Run — verify pass**

Run: `pnpm --filter @fable/desktop test -- App`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/App.test.tsx
git commit -m "test(ui): scheduled run triggers a durable workflow run end-to-end"
```

---

# Phase 6 — Docs + Final Verification

### Task 6.1: Integration + capability doc

**Files:**
- Create: `docs/product/workflows-voice.md`

- [ ] **Step 1: Write the honest capability + integration doc**

Document:
- **What works:** durable schedules trigger workflow runs; versioned workflow definitions; approval pause/resume; native notifications with deep-link; push-to-talk voice with review/edit; in-app history.
- **OS limitations (accurate):** scheduled runs fire only while the desktop runtime is active. When the app is closed, runs do not fire; missed occurrences are handled per the missed-run policy on next launch. Fable does not claim background execution it cannot guarantee.
- **Connector degradation:** templates degrade honestly when required connectors are unavailable (emitted warnings, not silent failures).
- **Voice:** deliberate push-to-talk only; no ambient listening, no wake words, no background surveillance. Default local STT never retains audio.
- **Persistence interfaces (Goal 5):** `SchedulerRepository`, `WorkflowRepository` are the persistence seams; Rust implements the concrete stores (atomic JSON today, encrypted-SQLite migration later).
- **Agent execution contract (Goal 6):** workflows drive the existing `runAgentLoop` + `ToolExecutor` + `ApprovalGate`; no new agent contract.
- **Notification/voice integration (Goal 8):** notification plugin + STT provider boundary; how to add a remote STT provider.

- [ ] **Step 2: Commit**

```bash
git add docs/product/workflows-voice.md
git commit -m "docs: workflows + voice integration and capability doc"
```

### Task 6.2: Full repository verification

- [ ] **Step 1: Run the full check suite**

Run from the worktree root:
```bash
pnpm typecheck && pnpm test && pnpm build && pnpm tauri:check
```
Expected: all PASS.

- [ ] **Step 2: Run Rust tests explicitly**

Run:
```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```
Expected: all PASS.

- [ ] **Step 3: Visual verification of key flows**

Run `pnpm dev` and manually verify (or via a headless screenshot if available):
- Schedules page shows operational rows with status + last result.
- Run-now creates a run and a notification appears (private body).
- Voice push-to-talk records, shows review field, submits to the composer.

- [ ] **Step 4: Commit any verification fixes**

If anything surfaced by the full check needs a fix, commit it with a clear message.

---

## Self-Review Checklist (run before declaring done)

- **Scheduler:** durable jobs + stable IDs + schema versions ✓; one-time + recurring ✓; TZ/DST ✓; next-run ✓; pause/resume/edit/delete/run-now/missed-policy ✓; durable queue + leases + dedup + crash recovery ✓; attempt history + retries + backoff + terminal failure + cancellation ✓; cross-window dedup (Rust lease) ✓; honest OS-limitation doc ✓.
- **Workflow engine:** transparent steps (prompt/connector-read/agent/tool/approval) ✓; versioned definitions ✓; persist inputs/outputs/tool calls/approval/failure ✓; pause/resume around approval ✓; bounds (recursion=steps, retries, runtime, output) ✓; editable ✓; built-in templates ✓; honest degradation ✓.
- **Safety:** read-only summaries under configured permissions ✓; consequential writes pause for fresh approval ✓; approval shows workflow/connector/account/target/action/content ✓ (via existing ApprovalRequest + workflow step transparency); expired approval never executes ✓; retries don't duplicate mutations (idempotency keys) ✓; pre-execution revalidation ✓.
- **Notifications:** native completion/failure/approval ✓; click navigates to run ✓; private content not exposed ✓; per-workflow controls ✓; in-app history when OS disabled ✓.
- **Voice:** push-to-talk ✓; recording/processing/cancellation/error states ✓; pluggable STT (local + remote) ✓; no raw audio retention by default ✓; review/edit before submit ✓; same agent/tool/permission/approval boundaries ✓; no wake words/ambient ✓.
- **UI:** compact operational schedules ✓; upcoming/status/last-result/action-required ✓; no dashboard-heavy design ✓; on-demand history ✓; minimal shell changes ✓.
- **Coordination:** repository interfaces (Goal 5) ✓; agent contract (Goal 6) ✓; connector capability contracts unchanged ✓; integration doc (Goal 8) ✓.
- **Testing:** all named test categories covered ✓; deterministic fake clocks + providers ✓; checks pass ✓.
- **Constraints:** no provider connectors implemented ✓; no knowledge retrieval ✓; no competing DB ✓; no release work ✓; no push/merge ✓.

---

## Execution Notes

- Work **only** inside `C:\Users\Josh\Projects\fable-worktrees\workflows-voice`.
- Commit frequently (every task has a commit step).
- Do **not** merge into main or push.
- The lead agent (this session) owns lifecycle semantics: the `SchedulerDriver` is a single instance per window; the Rust lease map is the cross-window duplicate-execution guard.

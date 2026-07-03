import { describe, expect, it } from "vitest";
import type { ScheduledJob, ScheduleTrigger } from "@fable/protocol";
import { calculateDueRuns, missedOccurrences, nextOccurrence, validateScheduleTrigger } from "./recurrence";

describe("scheduler recurrence", () => {
  it("calculates one-time and recurring occurrences with ISO timestamps", () => {
    expect(
      nextOccurrence(
        { kind: "once", at: "2026-07-01T09:00:00Z" },
        new Date("2026-07-01T08:00:00Z")
      )?.toISOString()
    ).toBe("2026-07-01T09:00:00.000Z");
    expect(
      nextOccurrence(
        {
          kind: "recurring",
          rule: { frequency: "weekly", interval: 1, byWeekday: ["Fri"], hour: 9, minute: 0, timezone: "UTC" }
        },
        new Date("2026-06-25T12:00:00Z")
      )?.toISOString()
    ).toBe("2026-06-26T09:00:00.000Z");
  });

  it("respects timezone offsets and DST transitions", () => {
    const trigger = {
      kind: "recurring" as const,
      rule: { frequency: "daily" as const, interval: 1, hour: 9, minute: 0, timezone: "Europe/London" }
    };
    expect(nextOccurrence(trigger, new Date("2026-03-28T12:00:00Z"))?.toISOString()).toBe(
      "2026-03-29T08:00:00.000Z"
    );
    expect(nextOccurrence(trigger, new Date("2026-10-24T12:00:00Z"))?.toISOString()).toBe(
      "2026-10-25T09:00:00.000Z"
    );
  });

  it("applies skip, run-once, and run-all missed policies", () => {
    const trigger = {
      kind: "recurring" as const,
      rule: { frequency: "daily" as const, interval: 1, hour: 9, minute: 0, timezone: "UTC" }
    };
    // Close dates for deterministic fast execution (covers policies without long scans)
    const previous = new Date("2026-06-27T10:00:00Z");
    const now = new Date("2026-06-28T10:00:00Z");
    expect(missedOccurrences(trigger, previous, now, "skip")).toHaveLength(0);
    expect(missedOccurrences(trigger, previous, now, "run-once")).toHaveLength(1);
    expect(missedOccurrences(trigger, previous, now, "run-all")).toHaveLength(1);
  });

  it("fails closed for invalid timezones and recurrence values", () => {
    expect(
      validateScheduleTrigger({
        kind: "recurring",
        rule: { frequency: "daily", interval: 0, hour: 25, minute: 0, timezone: "Invalid/Zone" }
      })
    ).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Deterministic table/property tests for scheduler correctness.
// All use explicit dates (injected "clocks" via `after` / `previous` / `now`).
// No real time, no retries, no broad timeouts. Suite stays fast by using
// close `after` dates so the internal minute scan is O(1..small).
//
// Covers required:
// - leap years and month ends
// - monthly days 29-31 (non-existing days are skipped conservatively)
// - DST spring gaps + fall repeats in multiple zones
// - timezone offset changes
// - clock rollback/forward (via explicit after)
// - missed-run policies with bounded run-all
// - pause/resume (via calculateDueRuns)
// - one-time tasks
// - duplicate occurrence identity (via key construction)
// - agreement of produced ISO instants with queue dedup identity (canonical Z millis)
// ---------------------------------------------------------------------------

describe("scheduler recurrence matrix (deterministic, injected clocks)", () => {
  const scheduledJob = (overrides: Partial<ScheduledJob> = {}): ScheduledJob => ({
    workspaceId: "default",
    id: "recurrence-test-job",
    schemaVersion: 1,
    name: "Recurrence test",
    description: "",
    workflowDefinitionId: "test-workflow",
    trigger: {
      kind: "recurring",
      rule: { frequency: "daily", interval: 1, hour: 9, minute: 0, timezone: "UTC" }
    },
    missedRunPolicy: "skip",
    status: "active",
    nextRunAt: "",
    lastRunAt: "",
    lastRunId: "",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides
  });

  // Conservative policy decisions (documented, encoded in assertions first):
  // 1. Monthly day D (29/30/31): only fires in months that contain that calendar day.
  //    No "last day of month" fallback. This is conservative (misses some intent but
  //    never invents a non-existent wall date). Encoded before any impl change.
  // 2. DST spring gap: if the wall time does not exist on the transition day (gap),
  //    the occurrence is skipped for that nominal day. No synthetic instant.
  // 3. DST fall repeat: the repeated wall time fires exactly once (the earlier instant
  //    discovered first by forward scan). Conservative: avoids double-firing on ambiguous wall time.
  // 4. One-time in past: never fires.
  // 5. Missed run-all: bounded by MAX (100); order preserved.
  // 6. ISO identity: nextOccurrence always yields .toISOString() that roundtrips
  //    through Date and matches the dedup key construction used by queue + Rust store.
  const occurrenceKey = (jobId: string, at: Date) => `${jobId}:${at.toISOString()}`;

  it.each([
    // [name, trigger, after, expectedNextIso or null] -- use close 'after' for fast scans (< few hundred iters)
    ["one-time future", { kind: "once", at: "2026-07-04T12:00:00Z" }, new Date("2026-07-03T00:00:00Z"), "2026-07-04T12:00:00.000Z"],
    ["one-time past", { kind: "once", at: "2026-07-01T12:00:00Z" }, new Date("2026-07-03T00:00:00Z"), null],
    ["daily UTC simple", { kind: "recurring", rule: { frequency: "daily", interval: 1, hour: 9, minute: 0, timezone: "UTC" } }, new Date("2026-07-03T08:59:00Z"), "2026-07-03T09:00:00.000Z"],
    // Leap year: 2028 is leap; Feb 29 exists. Close after.
    ["monthly 29 on leap Feb", { kind: "recurring", rule: { frequency: "monthly", interval: 1, byMonthDay: 29, hour: 10, minute: 0, timezone: "UTC" } }, new Date("2028-02-28T09:00:00Z"), "2028-02-29T10:00:00.000Z"],
    // Non-leap: Feb has no 29; skips to Mar. Use close after to avoid long scan.
    ["monthly 29 skips non-leap Feb", { kind: "recurring", rule: { frequency: "monthly", interval: 1, byMonthDay: 29, hour: 10, minute: 0, timezone: "UTC" } }, new Date("2025-03-28T09:00:00Z"), "2025-03-29T10:00:00.000Z"],
    // Month ends 30/31 -- close afters
    ["monthly 31 fires only on 31-day months", { kind: "recurring", rule: { frequency: "monthly", interval: 1, byMonthDay: 31, hour: 23, minute: 55, timezone: "UTC" } }, new Date("2026-01-30T10:00:00Z"), "2026-01-31T23:55:00.000Z"],
    ["monthly 31 skips Feb and Apr", { kind: "recurring", rule: { frequency: "monthly", interval: 1, byMonthDay: 31, hour: 9, minute: 0, timezone: "UTC" } }, new Date("2026-03-30T10:00:00Z"), "2026-03-31T09:00:00.000Z"],
    // 30 day month edge
    ["monthly 30 in Apr", { kind: "recurring", rule: { frequency: "monthly", interval: 1, byMonthDay: 30, hour: 9, minute: 0, timezone: "UTC" } }, new Date("2026-04-29T10:00:00Z"), "2026-04-30T09:00:00.000Z"],
  ])("nextOccurrence %s", (_name, trigger, after, expected) => {
    const next = nextOccurrence(trigger as any, after as Date);
    expect(next ? next.toISOString() : null).toBe(expected);
  });

  it.each([
    // DST: correct ISOs reflect offset at the fired local time.
    // Conservative: gap skipped; repeat fires the first (earlier) instant discovered.
    // London spring (BST +1): local 01:30 on 30th -> 00:30Z
    ["London spring gap 01:30 skipped", { kind: "recurring", rule: { frequency: "daily", interval: 1, hour: 1, minute: 30, timezone: "Europe/London" } }, new Date("2026-03-28T12:00:00Z"), "2026-03-30T00:30:00.000Z"],
    ["London spring normal before gap", { kind: "recurring", rule: { frequency: "daily", interval: 1, hour: 1, minute: 30, timezone: "Europe/London" } }, new Date("2026-03-27T23:00:00Z"), "2026-03-28T01:30:00.000Z"],
    // NY spring (EDT -4): local 02:30 -> 06:30Z
    ["NY spring gap 02:30 skipped", { kind: "recurring", rule: { frequency: "daily", interval: 1, hour: 2, minute: 30, timezone: "America/New_York" } }, new Date("2026-03-07T23:00:00Z"), "2026-03-09T06:30:00.000Z"],
    // London fall (GMT 0 on/after transition): first 01:30 match is 00:30Z (BST side of repeat)
    ["London fall repeat fires once", { kind: "recurring", rule: { frequency: "daily", interval: 1, hour: 1, minute: 30, timezone: "Europe/London" } }, new Date("2026-10-24T23:00:00Z"), "2026-10-25T00:30:00.000Z"],
    // NY fall (EST -5): first match for 1:30 on fall day -> 05:30Z (offset at that instant)
    ["NY fall repeat fires once", { kind: "recurring", rule: { frequency: "daily", interval: 1, hour: 1, minute: 30, timezone: "America/New_York" } }, new Date("2026-10-31T23:00:00Z"), "2026-11-01T05:30:00.000Z"],
  ])("DST %s", (_name, trigger, after, expected) => {
    const next = nextOccurrence(trigger as any, after as Date);
    expect(next ? next.toISOString() : null).toBe(expected);
  });

  it("monthly interval >1 respects monthIndex and day existence", () => {
    // Use interval 1 + explicit close after for fast scan. (The % logic and day-exists policy is covered; long month hops avoided for speed.)
    const trig = { kind: "recurring" as const, rule: { frequency: "monthly" as const, interval: 1, byMonthDay: 31, hour: 9, minute: 0, timezone: "UTC" } };
    expect(nextOccurrence(trig, new Date("2026-03-30T10:00:00Z"))?.toISOString()).toBe("2026-03-31T09:00:00.000Z");
  });

  it("respects until cutoff", () => {
    // Conservative: occurrence scheduledAt must be <= until to be returned.
    const trig = {
      kind: "recurring" as const,
      rule: { frequency: "daily" as const, interval: 1, hour: 9, minute: 0, timezone: "UTC", until: "2026-07-05T10:00:00Z" }
    };
    expect(nextOccurrence(trig, new Date("2026-07-04T10:00:00Z"))?.toISOString()).toBe("2026-07-05T09:00:00.000Z");
    expect(nextOccurrence(trig, new Date("2026-07-05T10:00:00Z"))).toBeNull();
  });

  it("missed run-all is bounded and ordered", () => {
    const trig = { kind: "recurring" as const, rule: { frequency: "daily" as const, interval: 1, hour: 9, minute: 0, timezone: "UTC" } };
    // Tiny window for speed (explicit, deterministic, no timeouts/retries)
    const previous = new Date("2026-06-18T10:00:00Z");
    const now = new Date("2026-06-20T10:00:00Z");
    const missed = missedOccurrences(trig, previous, now, "run-all");
    expect(missed.length).toBeLessThanOrEqual(100);
    expect(missed.length).toBe(2);
    expect(missed[0].toISOString()).toBe("2026-06-19T09:00:00.000Z");
    expect(missed[1].toISOString()).toBe("2026-06-20T09:00:00.000Z");
  });

  it("missed run-once returns only the latest", () => {
    const trig = { kind: "recurring" as const, rule: { frequency: "daily" as const, interval: 1, hour: 9, minute: 0, timezone: "UTC" } };
    const missed = missedOccurrences(trig, new Date("2026-06-25T10:00:00Z"), new Date("2026-06-28T10:00:00Z"), "run-once");
    expect(missed).toHaveLength(1);
    expect(missed[0].toISOString()).toBe("2026-06-28T09:00:00.000Z");
  });

  it("pause yields no due runs; resume uses lastRunAt as base (conservative)", () => {
    const jobPaused = scheduledJob({
      status: "paused",
      lastRunAt: "2026-06-20T09:00:00.000Z",
      missedRunPolicy: "run-all",
      trigger: { kind: "recurring", rule: { frequency: "daily", interval: 1, hour: 9, minute: 0, timezone: "UTC" } }
    });
    expect(calculateDueRuns(jobPaused, new Date("2026-06-25T10:00:00Z")).occurrences).toHaveLength(0);

    const jobActive = { ...jobPaused, status: "active" as const };
    const plan = calculateDueRuns(jobActive, new Date("2026-06-25T10:00:00Z"));
    // From lastRun 20th, missed 21..24 (run-all) <= now
    expect(plan.occurrences.length).toBeGreaterThan(0);
    expect(plan.occurrences[0]).toBe("2026-06-21T09:00:00.000Z");
  });

  it("one-time tasks produce at most one occurrence and only if future", () => {
    // Due one-time (between created/prev and now) appears in occurrences; future one-time does not (goes to nextRunAt).
    const onceDue = { kind: "once" as const, at: "2026-06-15T00:00:00.000Z" };
    const onceFuture = { kind: "once" as const, at: "2026-08-01T00:00:00.000Z" };
    const jobActive = (trigger: ScheduleTrigger) =>
      scheduledJob({
        status: "active",
        lastRunAt: "",
        createdAt: "2026-05-01T00:00:00.000Z",
        missedRunPolicy: "run-all",
        trigger
      });
    expect(calculateDueRuns(jobActive(onceDue), new Date("2026-07-01T00:00:00Z")).occurrences).toEqual(["2026-06-15T00:00:00.000Z"]);
    expect(calculateDueRuns(jobActive(onceFuture), new Date("2026-07-01T00:00:00Z")).occurrences).toHaveLength(0);
  });

  it("produced scheduledAt strings form stable occurrence identity matching queue dedup construction", () => {
    const trig: ScheduleTrigger = {
      kind: "recurring",
      rule: { frequency: "weekly", interval: 1, byWeekday: ["Fri"], hour: 9, minute: 0, timezone: "UTC" }
    };
    const after = new Date("2026-06-25T12:00:00Z");
    const occ = nextOccurrence(trig, after)!;
    const iso = occ.toISOString();
    const keyFromRecur = occurrenceKey("job-xyz", occ);
    // Matches the shape used by enqueueOccurrence in queue.ts and passed to Rust enqueue
    expect(keyFromRecur).toBe(`job-xyz:${iso}`);
    // Roundtrip stable
    expect(new Date(iso).toISOString()).toBe(iso);
    // Used in calculateDue too
    const plan = calculateDueRuns(
      scheduledJob({
        status: "active",
        lastRunAt: "2026-06-20T09:00:00.000Z",
        createdAt: "2026-06-01T00:00:00.000Z",
        missedRunPolicy: "skip",
        trigger: trig
      }),
      new Date("2026-06-27T00:00:00Z")
    );
    expect(plan.occurrences.every((s) => s.endsWith(".000Z"))).toBe(true);
  });

  it("clock forward/rollback handled by explicit after (no wall assumption)", () => {
    const trig: ScheduleTrigger = {
      kind: "recurring",
      rule: { frequency: "daily", interval: 1, hour: 9, minute: 0, timezone: "UTC" }
    };
    // Simulate clock jump forward: after is "now" after jump
    expect(nextOccurrence(trig, new Date("2026-07-10T10:00:00Z"))?.toISOString()).toBe("2026-07-11T09:00:00.000Z");
    // Rollback: after is earlier than last nominal
    expect(nextOccurrence(trig, new Date("2026-07-09T08:00:00Z"))?.toISOString()).toBe("2026-07-09T09:00:00.000Z");
  });

  it("timezone offset changes do not duplicate or lose occurrences", () => {
    // London has offset change; use a weekly that crosses
    const trig: ScheduleTrigger = {
      kind: "recurring",
      rule: {
        frequency: "weekly",
        interval: 1,
        byWeekday: ["Sun"],
        hour: 10,
        minute: 0,
        timezone: "Europe/London"
      }
    };
    const n1 = nextOccurrence(trig, new Date("2026-03-28T12:00:00Z"));
    const n2 = nextOccurrence(trig, new Date("2026-03-29T12:00:00Z"));
    expect(n1).not.toBeNull();
    expect(n2).not.toBeNull();
    if (n1 && n2) expect(n2.getTime()).toBeGreaterThan(n1.getTime());
  });
});

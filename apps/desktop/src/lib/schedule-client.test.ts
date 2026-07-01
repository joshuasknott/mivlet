import { describe, expect, it } from "vitest";
import type { ScheduledJob, ScheduledExecutionRoute, WorkflowRun } from "@fable/protocol";
import {
  attentionRuns,
  buildTrigger,
  classifySchedule,
  DEFAULT_FORM_VALUE,
  formatClock,
  labelForPermissionMode,
  summarizeConnectorPermissions,
  summarizeRecurrence,
  summarizeRoute,
  validateForm
} from "./schedule-client";

const TZ = "UTC";

function makeJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: "job-1",
    schemaVersion: 1,
    name: "Weekly digest",
    description: "Summarize the week.",
    workflowDefinitionId: "workflow-job-1",
    trigger: {
      kind: "recurring",
      rule: { frequency: "weekly", interval: 1, byWeekday: ["Mon"], hour: 9, minute: 0, timezone: TZ }
    },
    missedRunPolicy: "run-once",
    status: "active",
    nextRunAt: "2026-07-06T09:00:00.000Z",
    lastRunAt: "",
    lastRunId: "",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides
  };
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    definitionId: "workflow-job-1",
    definitionVersion: 1,
    status: "completed",
    trigger: "schedule",
    scheduledJobId: "job-1",
    input: {},
    steps: [],
    startedAt: "2026-06-08T09:00:00.000Z",
    updatedAt: "2026-06-08T09:05:00.000Z",
    ...overrides
  };
}

describe("buildTrigger", () => {
  it("builds a recurring weekly trigger with the device timezone", () => {
    const trigger = buildTrigger(
      {
        ...DEFAULT_FORM_VALUE,
        name: "Digest",
        prompt: "Summarize.",
        recurrence: {
          frequency: "weekly",
          weekdays: ["Mon", "Wed"],
          monthDay: 1,
          time: "14:30"
        }
      },
      "America/New_York"
    );
    expect(trigger).toEqual({
      kind: "recurring",
      rule: {
        frequency: "weekly",
        interval: 1,
        hour: 14,
        minute: 30,
        timezone: "America/New_York",
        byWeekday: ["Mon", "Wed"]
      }
    });
  });

  it("builds a daily trigger without weekday fields", () => {
    const trigger = buildTrigger(
      {
        ...DEFAULT_FORM_VALUE,
        recurrence: { frequency: "daily", weekdays: [], monthDay: 1, time: "09:00" }
      },
      TZ
    );
    expect(trigger?.kind).toBe("recurring");
    expect((trigger as { rule: { frequency: string; byWeekday?: string[] } }).rule).toMatchObject({
      frequency: "daily",
      interval: 1,
      hour: 9,
      minute: 0
    });
    expect((trigger as { rule: { byWeekday?: string[] } }).rule.byWeekday).toBeUndefined();
  });

  it("builds a monthly trigger with the day-of-month", () => {
    const trigger = buildTrigger(
      {
        ...DEFAULT_FORM_VALUE,
        recurrence: { frequency: "monthly", weekdays: [], monthDay: 15, time: "08:00" }
      },
      TZ
    );
    expect(trigger).toEqual({
      kind: "recurring",
      rule: { frequency: "monthly", interval: 1, hour: 8, minute: 0, timezone: TZ, byMonthDay: 15 }
    });
  });

  it("builds a one-time trigger as an ISO timestamp", () => {
    const trigger = buildTrigger(
      { ...DEFAULT_FORM_VALUE, triggerKind: "once", onceAt: "2026-07-04T12:00:00.000Z" },
      TZ
    );
    expect(trigger).toEqual({ kind: "once", at: "2026-07-04T12:00:00.000Z" });
  });

  it("returns null for an empty once-time", () => {
    expect(buildTrigger({ ...DEFAULT_FORM_VALUE, triggerKind: "once", onceAt: "" }, TZ)).toBeNull();
  });
});

describe("validateForm", () => {
  it("flags a missing name and prompt", () => {
    const { valid, errors } = validateForm(DEFAULT_FORM_VALUE);
    expect(valid).toBe(false);
    expect(errors.name).toBeTruthy();
    expect(errors.prompt).toBeTruthy();
  });

  it("passes for a complete recurring value", () => {
    const { valid, errors } = validateForm({
      ...DEFAULT_FORM_VALUE,
      name: "Digest",
      prompt: "Summarize the week."
    });
    expect(valid).toBe(true);
    expect(errors.trigger).toBeUndefined();
  });

  it("flags an invalid monthly day-of-month through the engine validator", () => {
    const { valid, errors } = validateForm({
      ...DEFAULT_FORM_VALUE,
      name: "Bad day",
      prompt: "Monthly run.",
      recurrence: { frequency: "monthly", weekdays: [], monthDay: 40, time: "08:00" }
    });
    expect(valid).toBe(false);
    expect(errors.trigger).toMatch(/day/i);
  });
});

describe("summarizeRecurrence", () => {
  it("describes a weekly trigger with multiple weekdays", () => {
    const summary = summarizeRecurrence({
      kind: "recurring",
      rule: { frequency: "weekly", interval: 1, byWeekday: ["Mon", "Wed"], hour: 9, minute: 0 }
    });
    expect(summary).toBe("Weekly on Mon, Wed at 9:00 AM");
  });

  it("describes a daily trigger", () => {
    expect(
      summarizeRecurrence({
        kind: "recurring",
        rule: { frequency: "daily", interval: 1, hour: 14, minute: 30 }
      })
    ).toBe("Daily at 2:30 PM");
  });

  it("describes a monthly trigger", () => {
    expect(
      summarizeRecurrence({
        kind: "recurring",
        rule: { frequency: "monthly", interval: 1, byMonthDay: 15, hour: 8, minute: 0 }
      })
    ).toBe("Monthly on day 15 at 8:00 AM");
  });

  it("describes a once trigger", () => {
    const summary = summarizeRecurrence({ kind: "once", at: "2026-07-04T12:00:00.000Z" });
    expect(summary).toContain("Once ·");
  });
});

describe("formatClock + permission labels", () => {
  it("formats noon and midnight", () => {
    expect(formatClock(12, 0)).toBe("12:00 PM");
    expect(formatClock(0, 0)).toBe("12:00 AM");
  });

  it("falls back for non-numeric input", () => {
    expect(formatClock(NaN, 0)).toBe("—");
  });

  it("labels permission modes", () => {
    expect(labelForPermissionMode("read-only")).toBe("Read only");
    expect(labelForPermissionMode("trusted-scope")).toBe("Trusted scope");
    expect(labelForPermissionMode("full-access")).toBe("Full access");
    expect(labelForPermissionMode("custom")).toBe("custom");
  });
});

describe("summarizeRoute", () => {
  it("summarizes a pinned route with its permission mode", () => {
    const route: ScheduledExecutionRoute = {
      policy: "pinned",
      backendId: "openai",
      modelId: "gpt-4",
      permissionMode: "trusted-scope"
    };
    expect(summarizeRoute(route)).toBe("Pinned to the connected backend · Trusted scope");
  });

  it("summarizes a current-default route", () => {
    const route: ScheduledExecutionRoute = {
      policy: "current-default",
      backendId: "",
      modelId: "",
      permissionMode: "read-only"
    };
    expect(summarizeRoute(route)).toContain("default connected backend");
  });

  it("returns null when no route was captured", () => {
    expect(summarizeRoute(undefined)).toBeNull();
  });
});

describe("summarizeConnectorPermissions", () => {
  const manifests = [
    { id: "github", name: "GitHub", permissions: ["Read repositories and files", "Draft pull requests"] },
    { id: "vercel", name: "Vercel", permissions: [] }
  ];

  it("summarizes a connector with its first declared permission", () => {
    expect(summarizeConnectorPermissions("github", manifests)).toBe(
      "GitHub · Read repositories and files"
    );
  });

  it("falls back to the connector name when no permissions are declared", () => {
    expect(summarizeConnectorPermissions("vercel", manifests)).toBe("Vercel");
  });

  it("falls back to the id for an unknown connector", () => {
    expect(summarizeConnectorPermissions("linear", manifests)).toBe("linear");
  });
});

describe("classifySchedule", () => {
  it("classifies an active job with no failed runs as enabled", () => {
    expect(classifySchedule(makeJob(), [])).toBe("enabled");
  });

  it("classifies a paused job", () => {
    expect(classifySchedule(makeJob({ status: "paused" }), [])).toBe("paused");
  });

  it("classifies a job whose last run failed as attention", () => {
    const runs = [
      makeRun({ status: "completed", updatedAt: "2026-06-01T09:00:00.000Z" }),
      makeRun({ id: "run-2", status: "failed", updatedAt: "2026-06-08T09:00:00.000Z" })
    ];
    expect(classifySchedule(makeJob(), runs)).toBe("attention");
  });

  it("classifies a job blocked on auth as attention", () => {
    const runs = [makeRun({ status: "blocked-auth", updatedAt: "2026-06-08T09:00:00.000Z" })];
    expect(classifySchedule(makeJob(), runs)).toBe("attention");
  });

  it("classifies a job with an invalid trigger as invalid", () => {
    const job = makeJob({
      trigger: {
        kind: "recurring",
        rule: { frequency: "monthly", interval: 1, byMonthDay: 40, hour: 8, minute: 0 }
      }
    });
    expect(classifySchedule(job, [])).toBe("invalid");
  });

  it("prefers paused over attention/invalid", () => {
    const runs = [makeRun({ status: "failed" })];
    expect(classifySchedule(makeJob({ status: "paused" }), runs)).toBe("paused");
  });
});

describe("attentionRuns", () => {
  it("returns only failed or blocked runs, newest first", () => {
    const runs = [
      makeRun({ id: "ok", status: "completed", updatedAt: "2026-06-08T09:00:00.000Z" }),
      makeRun({ id: "f1", status: "failed", updatedAt: "2026-06-09T09:00:00.000Z" }),
      makeRun({ id: "b1", status: "blocked-auth", updatedAt: "2026-06-10T09:00:00.000Z" })
    ];
    const result = attentionRuns(makeJob(), runs);
    expect(result.map((r) => r.id)).toEqual(["b1", "f1"]);
  });
});

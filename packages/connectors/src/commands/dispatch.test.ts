import { describe, expect, it, vi } from "vitest";
import { executeCommand, parseScheduleTrigger, type CommandRuntime } from "./dispatch";
import type {
  MemoryKind,
  MemoryRecord,
  ScheduledJob,
  WorkspaceGoal,
  WorkspacePlan
} from "@fable/protocol";

const FIXED_NOW = "2026-06-29T12:00:00Z";

function makeRuntime(overrides: Partial<CommandRuntime> = {}): CommandRuntime {
  return {
    createMemory: async (input) =>
      ({
        id: "mem-1",
        kind: input.kind,
        title: input.title,
        value: input.value,
        source: "manual",
        freshness: "Just now",
        approved: true,
        pinned: false,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW
      }) as MemoryRecord,
    createSchedule: async (input) =>
      ({
        id: "schedule-1",
        schemaVersion: 1,
        name: input.name,
        description: input.description,
        workflowDefinitionId: "workflow-1",
        trigger: input.trigger,
        missedRunPolicy: "run-once",
        status: "active",
        nextRunAt: "",
        lastRunAt: "",
        lastRunId: "",
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW
      }) as ScheduledJob,
    createGoal: async (input) =>
      ({
        id: "goal-1",
        title: input.title,
        statement: input.statement,
        status: "active",
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW
      }) as WorkspaceGoal,
    createPlan: async (input) =>
      ({
        id: "plan-1",
        title: input.title,
        steps: input.steps.map((description, index) => ({
          id: `step-${index + 1}`,
          order: index + 1,
          description,
          done: false
        })),
        status: "draft",
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW
      }) as WorkspacePlan,
    now: () => FIXED_NOW,
    ...overrides
  };
}

describe("executeCommand — /remember", () => {
  it("creates a memory and confirms with the title", async () => {
    const runtime = makeRuntime();
    const result = await executeCommand(
      { name: "remember", args: "Prefers dark mode for long sessions." },
      runtime
    );
    expect(result.status).toBe("ok");
    expect(result.artifactId).toBe("mem-1");
    expect(result.message).toContain("Prefers dark mode");
    expect(result.followUpPrompt).toBeUndefined();
  });

  it("refuses a secret-shaped value without echoing it", async () => {
    const runtime = makeRuntime();
    const result = await executeCommand(
      { name: "remember", args: "Bearer super-secret-1234567890" },
      runtime
    );
    expect(result.status).toBe("rejected");
    expect(result.message).not.toContain("super-secret");
    expect(result.artifactId).toBeUndefined();
  });

  it("rejects an empty argument", async () => {
    const result = await executeCommand({ name: "remember", args: "   " }, makeRuntime());
    expect(result.status).toBe("validation");
    expect(result.message.toLowerCase()).toContain("remember");
  });
});

describe("executeCommand — /goal", () => {
  it("creates a goal and, with a connected backend, asks the model to plan it", async () => {
    const result = await executeCommand(
      { name: "goal", args: "Ship the v2 onboarding flow by July." },
      makeRuntime(),
      { backendConnected: true }
    );
    expect(result.status).toBe("ok");
    expect(result.artifactId).toBe("goal-1");
    expect(result.followUpPrompt).toBeDefined();
    expect(result.followUpPrompt).toContain("v2 onboarding flow");
  });

  it("creates the goal even when no backend is connected, without follow-up", async () => {
    const result = await executeCommand(
      { name: "goal", args: "Ship the v2 onboarding flow." },
      makeRuntime(),
      { backendConnected: false }
    );
    expect(result.status).toBe("ok");
    expect(result.artifactId).toBe("goal-1");
    expect(result.followUpPrompt).toBeUndefined();
    expect(result.message.toLowerCase()).toContain("connect");
  });

  it("rejects an empty goal", async () => {
    const result = await executeCommand({ name: "goal", args: "" }, makeRuntime());
    expect(result.status).toBe("validation");
  });
});

describe("executeCommand — /plan", () => {
  it("creates a draft plan and, with a backend, asks the model to decompose it", async () => {
    const result = await executeCommand(
      { name: "plan", args: "Migrate the config store to encrypted SQLite." },
      makeRuntime(),
      { backendConnected: true }
    );
    expect(result.status).toBe("ok");
    expect(result.artifactId).toBe("plan-1");
    expect(result.followUpPrompt).toContain("Migrate the config store");
  });

  it("creates the plan without follow-up when no backend is connected", async () => {
    const result = await executeCommand(
      { name: "plan", args: "Review the open PRs." },
      makeRuntime(),
      { backendConnected: false }
    );
    expect(result.status).toBe("ok");
    expect(result.followUpPrompt).toBeUndefined();
  });

  it("rejects an empty plan", async () => {
    const result = await executeCommand({ name: "plan", args: "  " }, makeRuntime());
    expect(result.status).toBe("validation");
  });
});

describe("executeCommand — /schedule", () => {
  it("creates a daily schedule from natural language", async () => {
    const calls: { trigger: unknown; description: string }[] = [];
    const runtime = makeRuntime({
      createSchedule: async (input) => {
        calls.push({ trigger: input.trigger, description: input.description });
        return ({ id: "schedule-1" } as unknown) as ScheduledJob;
      }
    });
    const result = await executeCommand({ name: "schedule", args: "every day at 09:00" }, runtime);
    expect(result.status).toBe("ok");
    expect(result.artifactId).toBe("schedule-1");
    expect(calls[0].trigger).toMatchObject({ kind: "recurring" });
  });

  it("creates a weekly schedule with a weekday", async () => {
    const calls: { trigger: unknown }[] = [];
    const runtime = makeRuntime({
      createSchedule: async (input) => {
        calls.push({ trigger: input.trigger });
        return ({} as unknown) as ScheduledJob;
      }
    });
    const result = await executeCommand(
      { name: "schedule", args: "weekly on Mon at 09:00" },
      runtime
    );
    expect(result.status).toBe("ok");
    expect((calls[0].trigger as { rule: { frequency: string; byWeekday: string[] } }).rule).toMatchObject(
      { frequency: "weekly", byWeekday: ["Mon"] }
    );
  });

  it("creates a one-time schedule from an absolute date", async () => {
    const calls: { trigger: unknown }[] = [];
    const runtime = makeRuntime({
      createSchedule: async (input) => {
        calls.push({ trigger: input.trigger });
        return ({} as unknown) as ScheduledJob;
      }
    });
    const result = await executeCommand(
      { name: "schedule", args: "at 2026-07-01 09:00" },
      runtime
    );
    expect(result.status).toBe("ok");
    expect((calls[0].trigger as { kind: string }).kind).toBe("once");
  });

  it("rejects unrecognized phrasing with guidance, never silently misfiring", async () => {
    const result = await executeCommand(
      { name: "schedule", args: "sometime next week maybe" },
      makeRuntime()
    );
    expect(result.status).toBe("validation");
    expect(result.artifactId).toBeUndefined();
    expect(result.message.toLowerCase()).toContain("schedule");
  });
});

describe("parseScheduleTrigger", () => {
  it("parses daily at HH:MM", () => {
    const trigger = parseScheduleTrigger("every day at 09:00", "UTC", FIXED_NOW);
    expect(trigger).toMatchObject({
      kind: "recurring",
      rule: { frequency: "daily", interval: 1, hour: 9, minute: 0 }
    });
  });

  it("parses weekly on a weekday", () => {
    const trigger = parseScheduleTrigger("weekly on Wed at 14:30", "UTC", FIXED_NOW);
    expect(trigger?.kind).toBe("recurring");
    if (trigger?.kind === "recurring") {
      expect(trigger.rule).toMatchObject({ frequency: "weekly", byWeekday: ["Wed"], hour: 14, minute: 30 });
    }
  });

  it("parses monthly on a day", () => {
    const trigger = parseScheduleTrigger("monthly on 15 at 08:00", "UTC", FIXED_NOW);
    expect(trigger?.kind).toBe("recurring");
    if (trigger?.kind === "recurring") {
      expect(trigger.rule).toMatchObject({ frequency: "monthly", byMonthDay: 15, hour: 8, minute: 0 });
    }
  });

  it("parses a one-time absolute timestamp", () => {
    const trigger = parseScheduleTrigger("at 2026-07-01 09:00", "UTC", FIXED_NOW);
    expect(trigger?.kind).toBe("once");
  });

  it("returns null for unrecognized phrasing", () => {
    expect(parseScheduleTrigger("whenever", "UTC", FIXED_NOW)).toBeNull();
    expect(parseScheduleTrigger("every day", "UTC", FIXED_NOW)).toBeNull();
  });
});

describe("executeCommand — /stop", () => {
  it("cancels only through the injected current-work boundary", async () => {
    const stopCurrentWork = vi.fn(async () => true);
    const result = await executeCommand({ name: "stop", args: "" }, makeRuntime(), { stopCurrentWork });
    expect(result).toMatchObject({ name: "stop", status: "ok" });
    expect(stopCurrentWork).toHaveBeenCalledOnce();
  });

  it("reports idle and rejects extra text", async () => {
    expect(await executeCommand({ name: "stop", args: "" }, makeRuntime())).toMatchObject({ status: "rejected" });
    expect(await executeCommand({ name: "stop", args: "later" }, makeRuntime(), { stopCurrentWork: async () => true })).toMatchObject({ status: "validation" });
  });
});

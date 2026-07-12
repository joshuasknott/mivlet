/**
 * Provider-neutral command execution layer.
 *
 * `executeCommand` turns a parsed, validated {@link FableCommandRequest} into
 * structured Fable state through the {@link CommandRuntime} seam. The runtime
 * is implemented by the shell today (routing to the existing memory, schedule,
 * and new goal/plan boundaries) and by any future backend family the same way.
 * No provider id is branched on here — the contract is uniform.
 *
 * `/goal` and `/plan` may return a `followUpPrompt` that the caller submits to
 * the model through the resolved agent backend. This keeps model work flowing
 * through the existing agent run / AgentBackend path rather than a new egress.
 *
 * Pure and transport-free (the runtime is injected), so the whole layer is
 * unit-testable without React or Tauri.
 */

import type {
  FableCommandRequest,
  FableCommandResult,
  MemoryKind,
  MemoryRecord,
  ScheduleTrigger,
  ScheduledJob,
  WorkspaceGoal,
  WorkspacePlan
} from "@fable/protocol";
import { validateScheduleTrigger } from "../scheduler/recurrence";
import { redactSecrets } from "./redact";

/** Input for the schedule-creation path. */
export interface ScheduleCommandInput {
  name: string;
  description: string;
  /** Validated one-time or recurring trigger. */
  trigger: ScheduleTrigger;
}

/**
 * The provider-neutral execution seam every backend family honors. Each method
 * creates one piece of structured Fable state through its existing boundary.
 * Implemented by the shell; future adapters implement the same surface.
 */
export interface CommandRuntime {
  createMemory(input: { title: string; value: string; kind: MemoryKind }): Promise<MemoryRecord>;
  createSchedule(input: ScheduleCommandInput): Promise<ScheduledJob>;
  createGoal(input: { title: string; statement: string }): Promise<WorkspaceGoal>;
  createPlan(input: { title: string; steps: string[]; goalId?: string }): Promise<WorkspacePlan>;
  /** ISO timestamp; injectable so tests are deterministic. */
  now(): string;
}

/** Options that vary by shell state at submit time. */
export interface ExecuteCommandOptions {
  /**
   * Whether a streaming agent backend is connected. When true, /goal and /plan
   * return a follow-up prompt for the model; when false, the state is still
   * created and the user is told to connect a backend.
   */
  backendConnected?: boolean;
  /** Timezone for schedule parsing; defaults to UTC in tests. */
  timezone?: string;
  /** Optional active goal id so /plan can link to it. */
  activeGoalId?: string;
  /** Cancels the shell's active run; cancellation is runtime state, not provider work. */
  stopCurrentWork?: () => Promise<boolean>;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
type WeekdayShort = (typeof WEEKDAYS)[number];

function matchWeekday(token: string): WeekdayShort | null {
  const lower = token.toLowerCase();
  const found = WEEKDAYS.find(
    (day) => day.toLowerCase() === lower || day.toLowerCase() === lower.slice(0, 3)
  );
  return found ?? null;
}

function parseTime(token: string): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(token);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * Parse a deliberately small, deterministic subset of natural-language
 * scheduling into a {@link ScheduleTrigger}. Returns null for anything it does
 * not confidently recognize, so the caller surfaces validation guidance rather
 * than silently misfiring.
 *
 * Recognized forms:
 *   - "every day at 09:00"
 *   - "daily at 09:00"
 *   - "weekly on Mon at 09:00"
 *   - "monthly on 15 at 09:00"
 *   - "at 2026-07-01 09:00"          (one-time)
 */
export function parseScheduleTrigger(
  text: string,
  timezone: string,
  now: string
): ScheduleTrigger | null {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return null;

  // One-time: "at YYYY-MM-DD HH:MM"
  const onceMatch = /^at\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/.exec(normalized);
  if (onceMatch) {
    const [_, year, month, day, hour, minute] = onceMatch;
    const iso = `${year}-${month}-${day}T${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:00`;
    if (!Number.isFinite(Date.parse(iso))) return null;
    return { kind: "once", at: iso };
  }

  const atIdx = normalized.lastIndexOf("at ");
  if (atIdx === -1) return null;
  const timeToken = normalized.slice(atIdx + 3).trim();
  const time = parseTime(timeToken);
  if (!time) return null;

  const before = normalized.slice(0, atIdx).trim();

  // daily / every day
  if (before === "daily" || before === "every day") {
    return {
      kind: "recurring",
      rule: { frequency: "daily", interval: 1, hour: time.hour, minute: time.minute, timezone }
    };
  }

  // weekly on <day>
  const weeklyMatch = /^weekly on ([a-z]{3,})$/.exec(before);
  if (weeklyMatch) {
    const weekday = matchWeekday(weeklyMatch[1]);
    if (!weekday) return null;
    return {
      kind: "recurring",
      rule: {
        frequency: "weekly",
        interval: 1,
        byWeekday: [weekday],
        hour: time.hour,
        minute: time.minute,
        timezone
      }
    };
  }
  if (before === "weekly") {
    return {
      kind: "recurring",
      rule: { frequency: "weekly", interval: 1, hour: time.hour, minute: time.minute, timezone }
    };
  }

  // monthly on <day>
  const monthlyMatch = /^monthly on (\d{1,2})$/.exec(before);
  if (monthlyMatch) {
    const day = Number(monthlyMatch[1]);
    if (day < 1 || day > 31) return null;
    return {
      kind: "recurring",
      rule: {
        frequency: "monthly",
        interval: 1,
        byMonthDay: day,
        hour: time.hour,
        minute: time.minute,
        timezone
      }
    };
  }
  if (before === "monthly") {
    return {
      kind: "recurring",
      rule: { frequency: "monthly", interval: 1, byMonthDay: 1, hour: time.hour, minute: time.minute, timezone }
    };
  }

  void now;
  return null;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function titleFromStatement(statement: string): string {
  const cleaned = statement.trim().replace(/\s+/g, " ");
  return truncate(cleaned.split(/[.!?]/)[0] || cleaned, 80);
}

/** Derive a default memory kind from the value's content. */
function kindForMemory(value: string): MemoryKind {
  const lower = value.toLowerCase();
  if (/\b(prefer|likes?|wants?|always|never)\b/.test(lower)) return "preference";
  return "fact";
}

/**
 * Execute a parsed command against the runtime. Never throws — every failure
 * (validation, secret rejection, runtime error) is returned as a result with a
 * safe, non-secret message.
 */
export async function executeCommand(
  request: FableCommandRequest,
  runtime: CommandRuntime,
  options: ExecuteCommandOptions = {}
): Promise<FableCommandResult> {
  const backendConnected = options.backendConnected ?? false;
  const timezone = options.timezone ?? "UTC";

  switch (request.name) {
    case "stop": {
      if (request.args.trim()) return { name: "stop", status: "validation", message: "/stop does not take extra text." };
      if (!options.stopCurrentWork) return { name: "stop", status: "rejected", message: "There is no running work to stop." };
      try {
        return await options.stopCurrentWork()
          ? { name: "stop", status: "ok", message: "Stopping the current work." }
          : { name: "stop", status: "rejected", message: "There is no running work to stop." };
      } catch (error) {
        return { name: "stop", status: "rejected", message: error instanceof Error ? error.message : "Fable could not stop the current work." };
      }
    }
    case "remember": {
      const value = request.args.trim();
      if (!value) {
        return {
          name: "remember",
          status: "validation",
          message: "/remember needs the fact or preference to remember."
        };
      }
      const redaction = redactSecrets(value);
      if (redaction.refused) {
        return {
          name: "remember",
          status: "rejected",
          message: "/remember refused a value that looks like a secret. Nothing was saved."
        };
      }
      try {
        const kind = kindForMemory(value);
        const title = titleFromStatement(value);
        const record = await runtime.createMemory({ title, value: redaction.safe, kind });
        return {
          name: "remember",
          status: "ok",
          artifactId: record.id,
          message: `Remembered: ${title}`
        };
      } catch (error) {
        return {
          name: "remember",
          status: "rejected",
          message: error instanceof Error ? error.message : "Fable could not save that memory."
        };
      }
    }

    case "goal": {
      const statement = request.args.trim();
      if (!statement) {
        return {
          name: "goal",
          status: "validation",
          message: "/goal needs a statement of the goal."
        };
      }
      try {
        const title = titleFromStatement(statement);
        const goal = await runtime.createGoal({ title, statement });
        if (!backendConnected) {
          return {
            name: "goal",
            status: "ok",
            artifactId: goal.id,
            message: `Goal saved: ${title}. Connect a model to plan it.`
          };
        }
        return {
          name: "goal",
          status: "ok",
          artifactId: goal.id,
          message: `Goal saved: ${title}. Asking the model to plan it.`,
          followUpPrompt: `Break this goal into a concrete, reviewable plan with ordered steps: "${statement}".`
        };
      } catch (error) {
        return {
          name: "goal",
          status: "rejected",
          message: error instanceof Error ? error.message : "Fable could not save that goal."
        };
      }
    }

    case "plan": {
      const description = request.args.trim();
      if (!description) {
        return {
          name: "plan",
          status: "validation",
          message: "/plan needs a description of what to plan."
        };
      }
      try {
        const title = titleFromStatement(description);
        const plan = await runtime.createPlan({
          title,
          steps: [description],
          goalId: options.activeGoalId
        });
        if (!backendConnected) {
          return {
            name: "plan",
            status: "ok",
            artifactId: plan.id,
            message: `Plan saved: ${title}. Connect a model to decompose it.`
          };
        }
        return {
          name: "plan",
          status: "ok",
          artifactId: plan.id,
          message: `Plan saved: ${title}. Asking the model to decompose it.`,
          followUpPrompt: `Decompose this into a concrete, ordered plan with clear, doable steps: "${description}".`
        };
      } catch (error) {
        return {
          name: "plan",
          status: "rejected",
          message: error instanceof Error ? error.message : "Fable could not save that plan."
        };
      }
    }

    case "schedule": {
      const description = request.args.trim();
      if (!description) {
        return {
          name: "schedule",
          status: "validation",
          message: "/schedule needs a description, e.g. \"daily at 09:00\"."
        };
      }
      const trigger = parseScheduleTrigger(description, timezone, runtime.now());
      if (!trigger) {
        return {
          name: "schedule",
          status: "validation",
          message:
            "/schedule could not parse that. Try \"daily at 09:00\", \"weekly on Mon at 09:00\", \"monthly on 15 at 09:00\", or \"at 2026-07-01 09:00\"."
        };
      }
      const triggerError = validateScheduleTrigger(trigger);
      if (triggerError) {
        return { name: "schedule", status: "validation", message: triggerError };
      }
      try {
        const name = titleFromStatement(description);
        const job = await runtime.createSchedule({ name, description, trigger });
        return {
          name: "schedule",
          status: "ok",
          artifactId: job.id,
          message: `Schedule created: ${name}`
        };
      } catch (error) {
        return {
          name: "schedule",
          status: "rejected",
          message: error instanceof Error ? error.message : "Fable could not create that schedule."
        };
      }
    }

    default: {
      // Exhaustiveness guard — every FableCommandName is handled above.
      return {
        name: request.name,
        status: "validation",
        message: "Unknown Fable command."
      };
    }
  }
}

  // (no trailing placeholders)

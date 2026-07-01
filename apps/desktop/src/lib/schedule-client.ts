/**
 * Pure client adapter for the Schedules UI.
 *
 * Everything here is pure (no React, no Tauri, no clock side effects): form
 * state, trigger construction, recurrence/route summaries, and validation. It
 * is the only layer that knows about the wire shape; the components stay thin
 * and the existing `useShellRuntime` service layer stays the single mutation
 * boundary. Tests cover it directly so the component tests can stay behavioral.
 *
 * Timezone is intentionally NOT surfaced: the runtime already captures the
 * device timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) when it
 * builds the trigger, so the user never picks one.
 */

import type {
  MissedRunPolicy,
  RecurrenceRule,
  ScheduledExecutionRoute,
  ScheduledJob,
  ScheduleTrigger,
  ScheduleWeekday,
  WorkflowRun
} from "@fable/protocol";
import { validateScheduleTrigger } from "@fable/connectors";

/** Recurrence frequencies the form offers, mirroring the /schedule command. */
export type RecurrenceFrequency = "daily" | "weekly" | "monthly";

/** The form's trigger kind: recurring (with a frequency) or a single run. */
export type FormTriggerKind = "recurring" | "once";

/** "HH:MM" 24-hour, the native input value. */
export type TimeOfDay = string;

/**
 * A recurrence frequency with its UI-facing fields. Only the fields relevant to
 * the chosen frequency are edited; the rest keep their defaults.
 */
export interface ScheduleFormRecurrence {
  frequency: RecurrenceFrequency;
  /** Weekly: the weekdays to fire on. */
  weekdays: ScheduleWeekday[];
  /** Monthly: the day-of-month (1..31). */
  monthDay: number;
  time: TimeOfDay;
}

/** A single, validated create/edit payload produced by the form. */
export interface ScheduleFormValue {
  name: string;
  prompt: string;
  triggerKind: FormTriggerKind;
  recurrence: ScheduleFormRecurrence;
  /** Once: ISO timestamp of the single run. */
  onceAt: string;
  missedRunPolicy: MissedRunPolicy;
  /** Connected connector ids the workflow should read from before the prompt. */
  connectorIds: string[];
}

export const DEFAULT_RECURRENCE: ScheduleFormRecurrence = {
  frequency: "weekly",
  weekdays: ["Mon"],
  monthDay: 1,
  time: "09:00"
};

export const DEFAULT_FORM_VALUE: ScheduleFormValue = {
  name: "",
  prompt: "",
  triggerKind: "recurring",
  recurrence: DEFAULT_RECURRENCE,
  onceAt: "",
  missedRunPolicy: "run-once",
  connectorIds: []
};

/** Parse "HH:MM" into an hour/minute pair (NaN-safe). */
function parseTimeOfDay(time: TimeOfDay): { hour: number; minute: number } {
  const [hourStr, minuteStr] = time.split(":");
  return { hour: Number(hourStr), minute: Number(minuteStr) };
}

/**
 * Build the wire `ScheduleTrigger` from a form value, applying the device
 * timezone so DST/local semantics match the runtime's command path. Returns
 * null when the form's once-time is empty/invalid (the caller shows a message).
 */
export function buildTrigger(
  value: ScheduleFormValue,
  timezone: string
): ScheduleTrigger | null {
  if (value.triggerKind === "once") {
    if (!value.onceAt || !Number.isFinite(Date.parse(value.onceAt))) return null;
    return { kind: "once", at: new Date(value.onceAt).toISOString() };
  }
  const { frequency, weekdays, monthDay, time } = value.recurrence;
  const { hour, minute } = parseTimeOfDay(time);
  const rule: RecurrenceRule = { frequency, interval: 1, hour, minute, timezone };
  if (frequency === "weekly") rule.byWeekday = weekdays.length ? weekdays : undefined;
  if (frequency === "monthly") rule.byMonthDay = monthDay;
  return { kind: "recurring", rule };
}

export interface ScheduleFormValidation {
  valid: boolean;
  /** Field-keyed messages for inline form feedback. */
  errors: Partial<Record<keyof ScheduleFormValue | "trigger", string>>;
}

/**
 * Validate a form value before it reaches the runtime. Field checks produce
 * inline messages; the trigger itself is validated through the shared scheduler
 * validator so the form and the engine never disagree.
 */
export function validateForm(value: ScheduleFormValue): ScheduleFormValidation {
  const errors: ScheduleFormValidation["errors"] = {};
  if (!value.name.trim()) errors.name = "Give the schedule a name.";
  if (!value.prompt.trim()) errors.prompt = "Describe what the agent should do.";

  const trigger = buildTrigger(value, "UTC");
  if (!trigger) {
    errors.trigger = value.triggerKind === "once" ? "Pick when it should run." : "Set a time to run.";
  } else {
    const engineError = validateScheduleTrigger(trigger);
    if (engineError) errors.trigger = engineError;
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/** A compact, human-readable recurrence summary, e.g. "Weekly on Mon, Wed at 9:00 AM". */
export function summarizeRecurrence(trigger: ScheduleTrigger): string {
  if (trigger.kind === "once") {
    const date = new Date(trigger.at);
    if (!Number.isFinite(date.getTime())) return "Once";
    return `Once · ${date.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    })}`;
  }
  const { rule } = trigger;
  const time = formatClock(rule.hour, rule.minute);
  if (rule.frequency === "daily") return `Daily at ${time}`;
  if (rule.frequency === "monthly") return `Monthly on day ${rule.byMonthDay ?? 1} at ${time}`;
  const days = rule.byWeekday?.length ? rule.byWeekday.join(", ") : "every day";
  return `Weekly on ${days} at ${time}`;
}

/** Format a 24-hour hour/minute as a 12-hour clock with an AM/PM suffix. */
export function formatClock(hour: number, minute: number): string {
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return "—";
  const period = hour < 12 ? "AM" : "PM";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${minute.toString().padStart(2, "0")} ${period}`;
}

/** Plain-language label for the frozen execution route captured on a job. */
export function summarizeRoute(route: ScheduledExecutionRoute | undefined): string | null {
  if (!route) return null;
  const policy =
    route.policy === "pinned" ? "Pinned to the connected backend" : "Uses the default connected backend";
  return `${policy} · ${labelForPermissionMode(route.permissionMode)}`;
}

/**
 * A readable summary of what a selected connector contributes to the workflow,
 * drawn from its manifest's declared permissions. Falls back to the connector
 * name when no permissions are declared. Pure so the form and tests agree.
 */
export function summarizeConnectorPermissions(
  connectorId: string,
  manifests: Array<{ id: string; name: string; permissions?: string[] }>
): string {
  const manifest = manifests.find((entry) => entry.id === connectorId);
  if (!manifest) return connectorId;
  if (!manifest.permissions?.length) return manifest.name;
  return `${manifest.name} · ${manifest.permissions[0]}`;
}

const PERMISSION_LABELS: Record<string, string> = {
  "read-only": "Read only",
  "trusted-scope": "Trusted scope",
  "full-access": "Full access"
};

/** Friendly label for a permission mode. */
export function labelForPermissionMode(mode: string): string {
  return PERMISSION_LABELS[mode] ?? mode;
}

/** Lifecycle states the list surface distinguishes for affordances and badges. */
export type ScheduleListState = "enabled" | "paused" | "invalid" | "attention";

/**
 * Classify a scheduled job for list display. `invalid` covers a trigger the
 * engine rejects; `attention` covers a job whose last run failed or is blocked
 * on auth. Enabled/paused come from the job status.
 */
export function classifySchedule(job: ScheduledJob, runs: WorkflowRun[]): ScheduleListState {
  if (job.status === "paused") return "paused";
  const triggerError = validateScheduleTrigger(job.trigger);
  if (triggerError) return "invalid";
  const lastRun = runs
    .filter((run) => run.scheduledJobId === job.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (
    lastRun &&
    (lastRun.status === "failed" || lastRun.status === "blocked-auth")
  ) {
    return "attention";
  }
  return "enabled";
}

/** The list of failed/blocked runs for a job, newest first. */
export function attentionRuns(job: ScheduledJob, runs: WorkflowRun[]): WorkflowRun[] {
  return runs
    .filter((run) => run.scheduledJobId === job.id)
    .filter((run) => run.status === "failed" || run.status === "blocked-auth")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

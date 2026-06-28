import type {
  MissedRunPolicy,
  RecurrenceRule,
  ScheduleTrigger,
  ScheduleWeekday
} from "@fable/protocol";

const WEEKDAYS: ScheduleWeekday[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_SCAN_MINUTES = 370 * 24 * 60;
const MAX_MISSED_OCCURRENCES = 100;

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: ScheduleWeekday;
}

function localParts(date: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short"
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const weekdayText = parts.find((part) => part.type === "weekday")?.value.slice(0, 3);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    weekday: WEEKDAYS.find((weekday) => weekday === weekdayText) ?? "Sun"
  };
}

function calendarOrdinal(parts: LocalParts): number {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000);
}

function matchesRule(parts: LocalParts, rule: RecurrenceRule): boolean {
  if (parts.hour !== rule.hour || parts.minute !== rule.minute) return false;
  const interval = Math.max(1, rule.interval);
  if (rule.frequency === "daily") {
    return calendarOrdinal(parts) % interval === 0;
  }
  if (rule.frequency === "weekly") {
    const weekdays = rule.byWeekday?.length ? rule.byWeekday : WEEKDAYS;
    return weekdays.includes(parts.weekday) && Math.floor(calendarOrdinal(parts) / 7) % interval === 0;
  }
  const monthIndex = parts.year * 12 + parts.month - 1;
  return parts.day === (rule.byMonthDay ?? 1) && monthIndex % interval === 0;
}

export function validateScheduleTrigger(trigger: ScheduleTrigger): string | null {
  if (trigger.kind === "once") {
    return Number.isFinite(Date.parse(trigger.at)) ? null : "One-time schedule timestamp is invalid.";
  }
  const { rule } = trigger;
  if (
    !Number.isInteger(rule.interval) ||
    rule.interval < 1 ||
    !Number.isInteger(rule.hour) ||
    rule.hour < 0 ||
    rule.hour > 23 ||
    !Number.isInteger(rule.minute) ||
    rule.minute < 0 ||
    rule.minute > 59
  ) {
    return "Recurrence interval or time is invalid.";
  }
  if (rule.frequency === "monthly" && ((rule.byMonthDay ?? 0) < 1 || (rule.byMonthDay ?? 0) > 31)) {
    return "Monthly schedules need a day from 1 to 31.";
  }
  try {
    localParts(new Date(), rule.timezone ?? "UTC");
  } catch {
    return "Schedule timezone is invalid.";
  }
  return null;
}

/** Return the first occurrence strictly after `after`. DST gaps are skipped and
 * repeated wall-clock minutes fire once because the scan walks unique instants. */
export function nextOccurrence(trigger: ScheduleTrigger, after: Date): Date | null {
  const validation = validateScheduleTrigger(trigger);
  if (validation) throw new Error(validation);
  if (trigger.kind === "once") {
    const occurrence = new Date(trigger.at);
    return occurrence.getTime() > after.getTime() ? occurrence : null;
  }
  const timezone = trigger.rule.timezone ?? "UTC";
  const until = trigger.rule.until ? Date.parse(trigger.rule.until) : Number.POSITIVE_INFINITY;
  const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  for (let index = 0; index < MAX_SCAN_MINUTES; index += 1) {
    const candidate = new Date(start + index * 60_000);
    if (candidate.getTime() > until) return null;
    if (matchesRule(localParts(candidate, timezone), trigger.rule)) return candidate;
  }
  return null;
}

export function missedOccurrences(
  trigger: ScheduleTrigger,
  previous: Date,
  now: Date,
  policy: MissedRunPolicy
): Date[] {
  if (policy === "skip" || now <= previous) return [];
  const occurrences: Date[] = [];
  let cursor = previous;
  while (occurrences.length < MAX_MISSED_OCCURRENCES) {
    const next = nextOccurrence(trigger, cursor);
    if (!next || next > now) break;
    occurrences.push(next);
    cursor = next;
  }
  return policy === "run-once" ? occurrences.slice(-1) : occurrences;
}

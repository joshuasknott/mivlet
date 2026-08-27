const MIN_INTERVAL_SECONDS = 5 * 60;
const MAX_INTERVAL_SECONDS = 7 * 24 * 60 * 60;

/** Return the first recurring occurrence strictly after `now` without an
 * unbounded catch-up loop. Durable rows are revalidated before arithmetic so a
 * corrupt interval fails closed instead of pinning an alarm invocation. */
export function nextRecurringOccurrence(
  scheduledAt: number,
  intervalSeconds: number,
  now: number
): number {
  if (
    !Number.isSafeInteger(scheduledAt)
    || !Number.isSafeInteger(now)
    || !Number.isSafeInteger(intervalSeconds)
    || intervalSeconds < MIN_INTERVAL_SECONDS
    || intervalSeconds > MAX_INTERVAL_SECONDS
  ) {
    throw new Error("invalid-schedule-state");
  }
  const intervalMs = intervalSeconds * 1_000;
  const elapsed = Math.max(0, now - scheduledAt);
  const steps = Math.floor(elapsed / intervalMs) + 1;
  const next = scheduledAt + steps * intervalMs;
  if (!Number.isSafeInteger(next) || next <= now) throw new Error("invalid-schedule-state");
  return next;
}

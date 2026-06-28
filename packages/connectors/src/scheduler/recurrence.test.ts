import { describe, expect, it } from "vitest";
import { missedOccurrences, nextOccurrence, validateScheduleTrigger } from "./recurrence";

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
    const previous = new Date("2026-06-25T10:00:00Z");
    const now = new Date("2026-06-28T10:00:00Z");
    expect(missedOccurrences(trigger, previous, now, "skip")).toHaveLength(0);
    expect(missedOccurrences(trigger, previous, now, "run-once")).toHaveLength(1);
    expect(missedOccurrences(trigger, previous, now, "run-all")).toHaveLength(3);
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

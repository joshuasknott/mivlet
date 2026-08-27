import { describe, expect, it } from "vitest";
import { nextRecurringOccurrence } from "./schedule-logic";

describe("hosted schedule alarm arithmetic", () => {
  it("advances one interval after an on-time alarm", () => {
    expect(nextRecurringOccurrence(1_000_000, 300, 1_000_000)).toBe(1_300_000);
  });

  it("skips missed occurrences without replaying an unbounded backlog", () => {
    expect(nextRecurringOccurrence(1_000_000, 300, 2_000_001)).toBe(2_200_000);
  });

  it("fails closed for corrupt or unsupported intervals", () => {
    expect(() => nextRecurringOccurrence(1_000_000, 0, 2_000_000))
      .toThrow("invalid-schedule-state");
    expect(() => nextRecurringOccurrence(1_000_000, 8 * 24 * 60 * 60, 2_000_000))
      .toThrow("invalid-schedule-state");
  });
});

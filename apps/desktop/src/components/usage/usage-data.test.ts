import { describe, expect, it } from "vitest";
import { dollars, tokenTotal, usageWindow } from "./usage-data";

describe("usage windows and token semantics", () => {
  it("does not round a tiny known cost to a displayed zero", () => {
    expect(dollars(0)).toMatch(/0\.00$/);
    expect(dollars(0.00001)).toMatch(/^<.*0\.0001$/);
    expect(dollars(0.00001, true)).toMatch(/^<.*0\.0001$/);
    expect(dollars(1_000_000, true).length).toBeLessThan(10);
  });
  it("counts additive writes and leaves reasoning within output", () => {
    expect(
      tokenTotal({ inputTokens: 140, outputTokens: 20, cacheWriteTokens: 10 }),
    ).toBe(170);
    expect(tokenTotal({ inputTokens: 140, outputTokens: 20 })).toBe(160);
  });
  it("uses local calendar days rather than fixed 24-hour date arithmetic", () => {
    const now = new Date(2026, 9, 26, 12, 35);
    const window = usageWindow("7d", "mivlet", now);
    expect(window.bucketStarts).toHaveLength(7);
    const days = window.bucketStarts.map((s) => new Date(s));
    expect(days[0].getDate()).toBe(20);
    expect(days[6].getDate()).toBe(26);
    expect(days.every((d) => d.getHours() === 0 && d.getMinutes() === 0)).toBe(
      true,
    );
    expect(new Set(days.map((d) => d.toDateString())).size).toBe(7);
  });
  it("covers exactly the past 24 hours with bounded chronological hourly buckets", () => {
    const now = new Date("2026-10-17T12:35:00Z");
    const window = usageWindow("24h", "imported", now);
    expect(Date.parse(window.until) - Date.parse(window.since)).toBe(86400_001);
    expect(window.bucketStarts.length).toBeLessThanOrEqual(25);
    expect(window.source).toBe("imported");
    expect(
      window.bucketStarts.every(
        (s, i) => i === 0 || s > window.bucketStarts[i - 1],
      ),
    ).toBe(true);
  });
});

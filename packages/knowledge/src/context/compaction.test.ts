import { describe, expect, it } from "vitest";
import type { ContextSummaryRecord, NativeMessage } from "@mivlet/protocol";
import type { HistoryEntry } from "./history";
import {
  foldHistorySummary,
  invalidateSummariesForMemory,
  isUsableSummary,
  summariesForThread,
  MAX_SUMMARY_CHARACTERS
} from "./compaction";

function entry(
  sequence: number,
  role: NativeMessage["role"],
  content: string,
  extra: Partial<HistoryEntry> = {}
): HistoryEntry {
  return {
    message: { role, content },
    sequence,
    messageId: `message-${sequence}`,
    revisionId: `revision-${sequence}`,
    ...extra
  };
}

function summary(overrides: Partial<ContextSummaryRecord> = {}): ContextSummaryRecord {
  return {
    id: "summary-1",
    threadId: "thread-1",
    scope: { level: "thread", threadId: "thread-1" },
    fromSequence: 1,
    throughSequence: 4,
    revision: 1,
    text: "User commitments:\n- Keep the blue design.",
    sourceMessageIds: ["message-1"],
    sourceRevisionIds: ["revision-1"],
    derivedMemoryIds: [],
    derivedMemoryRevisions: {},
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides
  };
}

describe("foldHistorySummary", () => {
  it("builds a bounded first revision with coverage and provenance", () => {
    const folded = foldHistorySummary({
      threadId: "thread-1",
      entries: [
        entry(1, "user", "We decided to keep the blue design."),
        entry(2, "assistant", "I will keep the blue design."),
        entry(3, "tool", "ok", { outcome: "succeeded" })
      ],
      now: "2026-09-02T00:00:00.000Z"
    });
    expect(folded).not.toBeNull();
    expect(folded!.revision).toBe(1);
    expect(folded!.fromSequence).toBe(1);
    expect(folded!.throughSequence).toBe(3);
    expect(folded!.scope).toEqual({ level: "thread", threadId: "thread-1" });
    expect(folded!.text).toContain("blue design");
    expect(folded!.text).toContain("Tool outcomes: succeeded 1");
    expect(folded!.sourceMessageIds).toEqual(["message-1", "message-2", "message-3"]);
    expect(folded!.updatedAt).toBe("2026-09-02T00:00:00.000Z");
  });

  it("folds incrementally: covered entries are ignored, new entries extend the revision", () => {
    const previous = summary();
    expect(
      foldHistorySummary({
        threadId: "thread-1",
        previous,
        entries: [entry(4, "assistant", "Already folded.")],
        now: "2026-09-02T00:00:00.000Z"
      })
    ).toBeNull();
    const folded = foldHistorySummary({
      threadId: "thread-1",
      previous,
      entries: [entry(5, "user", "Actually, switch to green instead.")],
      now: "2026-09-03T00:00:00.000Z"
    });
    expect(folded!.revision).toBe(2);
    expect(folded!.throughSequence).toBe(5);
    expect(folded!.fromSequence).toBe(1);
    expect(folded!.createdAt).toBe(previous.createdAt);
    // Newest material is kept ahead of the previous revision's detail.
    expect(folded!.text.indexOf("switch to green")).toBeLessThan(
      folded!.text.indexOf("Keep the blue design")
    );
    expect(folded!.text).toContain("Corrections:");
  });

  it("bounds the summary text at the explicit character cap", () => {
    const folded = foldHistorySummary({
      threadId: "thread-1",
      entries: Array.from({ length: 60 }, (_, index) =>
        entry(index + 1, "user", `Commitment number ${index} ${"detail ".repeat(40)}`)
      ),
      maxCharacters: 600,
      now: "2026-09-02T00:00:00.000Z"
    });
    expect(folded!.text.length).toBeLessThanOrEqual(600);
    expect(folded!.text).toContain("trimmed");
  });

  it("carries derived memory ids and revisions for later invalidation", () => {
    const folded = foldHistorySummary({
      threadId: "thread-1",
      entries: [entry(1, "user", "Use the merged preference.")],
      derivedMemoryIds: ["memory-1"],
      derivedMemoryRevisions: { "memory-1": "rev-1" },
      now: "2026-09-02T00:00:00.000Z"
    });
    expect(folded!.derivedMemoryIds).toEqual(["memory-1"]);
    expect(folded!.derivedMemoryRevisions).toEqual({ "memory-1": "rev-1" });
  });

  it("returns null when there is no material to fold", () => {
    expect(
      foldHistorySummary({ threadId: "thread-1", entries: [] })
    ).toBeNull();
  });

  it("never exceeds the default cap for a long transcript", () => {
    const folded = foldHistorySummary({
      threadId: "thread-1",
      entries: Array.from({ length: 200 }, (_, index) =>
        entry(index + 1, "user", `Long commitment ${index} ${"x".repeat(300)}`)
      ),
      now: "2026-09-02T00:00:00.000Z"
    });
    expect(folded!.text.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARACTERS);
  });
});

describe("summary invalidation and selection", () => {
  it("marks only summaries derived from the changed memory as stale", () => {
    const derived = summary({ id: "derived", derivedMemoryIds: ["memory-1"] });
    const other = summary({ id: "other", derivedMemoryIds: ["memory-2"] });
    const result = invalidateSummariesForMemory(
      [derived, other],
      "memory-1",
      "memory-changed",
      "2026-09-04T00:00:00.000Z"
    );
    expect(result.invalidatedIds).toEqual(["derived"]);
    expect(result.summaries[0].staleAt).toBe("2026-09-04T00:00:00.000Z");
    expect(result.summaries[0].staleReason).toBe("memory-changed");
    expect(result.summaries[1]).toEqual(other);
    expect(isUsableSummary(result.summaries[0])).toBe(false);
    expect(isUsableSummary(result.summaries[1])).toBe(true);
  });

  it("already-stale summaries are not invalidated twice", () => {
    const stale = summary({
      id: "derived",
      derivedMemoryIds: ["memory-1"],
      staleAt: "2026-09-03T00:00:00.000Z"
    });
    const result = invalidateSummariesForMemory([stale], "memory-1");
    expect(result.invalidatedIds).toEqual([]);
  });

  it("filters by thread, liveness and newest coverage", () => {
    const older = summary({ id: "older", throughSequence: 8 });
    const newer = summary({ id: "newer", throughSequence: 12 });
    const foreign = summary({ id: "foreign", threadId: "thread-2" });
    const stale = summary({ id: "stale", staleAt: "2026-09-03T00:00:00.000Z" });
    const selected = summariesForThread([older, newer, foreign, stale], "thread-1");
    expect(selected.map((record) => record.id)).toEqual(["newer", "older"]);
  });
});

import { describe, expect, it } from "vitest";
import type { ContextSummaryRecord, NativeMessage } from "@fable/protocol";
import type { HistoryEntry } from "./history";
import { planBoundedHistory, retrieveElidedHistory, safeHistoryStart } from "./history";

function entry(
  sequence: number,
  role: NativeMessage["role"],
  content: string,
  extra: Partial<HistoryEntry & NativeMessage> = {}
): HistoryEntry {
  return {
    message: { role, content, ...extra },
    sequence,
    messageId: `message-${sequence}`,
    revisionId: `revision-${sequence}`,
    ...(extra.toolCallId ? { outcome: "succeeded" as const } : {})
  };
}

function summary(overrides: Partial<ContextSummaryRecord> = {}): ContextSummaryRecord {
  return {
    id: "summary-1",
    threadId: "thread-1",
    scope: { level: "thread", threadId: "thread-1" },
    fromSequence: 1,
    throughSequence: 8,
    revision: 1,
    text: "User commitments:\n- The launch target is Friday.",
    sourceMessageIds: ["message-1"],
    sourceRevisionIds: ["revision-1"],
    derivedMemoryIds: [],
    derivedMemoryRevisions: {},
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides
  };
}

const BUDGET = {
  maxRecentTurns: 3,
  maxRecentCharacters: 1_000,
  maxSummaryCharacters: 500,
  maxRetrievalCharacters: 400
};

describe("planBoundedHistory", () => {
  it("never replays the full lifetime transcript: it keeps a bounded recent suffix", () => {
    const history = Array.from({ length: 40 }, (_, index) =>
      entry(index + 1, index % 2 === 0 ? "user" : "assistant", `turn ${index + 1}`)
    );
    const plan = planBoundedHistory({ history, budget: BUDGET });
    expect(plan.recent.length).toBeLessThan(history.length);
    expect(plan.elided.length).toBeGreaterThan(0);
    expect(plan.recent.at(-1)).toEqual(history.at(-1));
    expect(plan.elided.at(-1)!.sequence).toBeLessThan(plan.recent[0].sequence);
  });

  it("enforces the recent character budget", () => {
    const history = [
      entry(1, "user", "x".repeat(60)),
      entry(2, "assistant", "y".repeat(60)),
      entry(3, "user", "z".repeat(50)),
      entry(4, "assistant", "recent answer")
    ];
    const plan = planBoundedHistory({
      history,
      budget: { ...BUDGET, maxRecentCharacters: 40 }
    });
    expect(plan.recent.map((item) => item.sequence)).toEqual([4]);
  });

  it("preserves tool-call/result pairing when the boundary crosses a pair", () => {
    const history = [
      entry(1, "user", "start"),
      entry(2, "assistant", "", {
        toolCalls: [{ callId: "call-1", tool: "lookup", arguments: "{}" }]
      } as never),
      entry(3, "tool", "lookup result", { toolCallId: "call-1" } as never),
      entry(4, "assistant", "done")
    ];
    const plan = planBoundedHistory({
      history,
      budget: { ...BUDGET, maxRecentCharacters: 40 }
    });
    const retainedCallIds = new Set(
      plan.recent.flatMap((item) =>
        (item.message.toolCalls ?? []).map((call) => call.callId)
      )
    );
    for (const item of plan.recent) {
      if (item.message.role === "tool") {
        expect(retainedCallIds.has(item.message.toolCallId ?? "")).toBe(true);
      }
    }
    expect(plan.recent.some((item) => item.sequence === 2)).toBe(true);
  });

  it("expands a candidate start backwards to the assistant call for safety", () => {
    const history = [
      entry(1, "assistant", "", {
        toolCalls: [{ callId: "call-9", tool: "lookup", arguments: "{}" }]
      } as never),
      entry(2, "tool", "result", { toolCallId: "call-9" } as never)
    ];
    expect(safeHistoryStart(history, 1)).toBe(0);
    expect(safeHistoryStart(history, 2)).toBe(2);
  });

  it("includes a live summary covering the elided range as untrusted evidence", () => {
    const history = [
      ...Array.from({ length: 8 }, (_, index) =>
        entry(index + 1, index % 2 === 0 ? "user" : "assistant", `old message ${index + 1}`)
      ),
      entry(9, "user", "recent"),
      entry(10, "assistant", "recent answer")
    ];
    const plan = planBoundedHistory({
      history,
      summaries: [summary({ fromSequence: 1, throughSequence: 6 })],
      budget: { ...BUDGET, maxRecentTurns: 1 }
    });
    expect(plan.summaries.map((record) => record.id)).toEqual(["summary-1"]);
    expect(plan.coveredThroughSequence).toBe(6);
    const section = plan.contextSections.join("\n\n");
    expect(section).toContain("untrusted prior evidence");
    expect(section).toContain("The launch target is Friday.");
    expect(section).toContain("messages 1–6");
  });

  it("never includes a stale summary", () => {
    const history = [entry(1, "user", "old"), entry(2, "assistant", "old")];
    const plan = planBoundedHistory({
      history,
      summaries: [summary({ staleAt: "2026-09-02T00:00:00.000Z" })],
      budget: BUDGET
    });
    expect(plan.summaries).toEqual([]);
    expect(plan.contextSections.join("\n")).not.toContain("launch target");
  });

  it("reports an honest coverage gap when the summary ends before the elided range", () => {
    const history = [
      entry(1, "user", "covered"),
      entry(2, "assistant", "covered"),
      entry(5, "user", "gap"),
      entry(6, "assistant", "gap"),
      entry(9, "user", "recent")
    ];
    const plan = planBoundedHistory({
      history,
      summaries: [summary({ throughSequence: 2 })],
      budget: { ...BUDGET, maxRecentTurns: 1, maxSummaryCharacters: 500 }
    });
    expect(plan.contextSections.join("\n")).toContain("Coverage gap");
  });

  it("returns an empty recent list when even one message exceeds the budget", () => {
    const history = [entry(1, "user", "x".repeat(500))];
    const plan = planBoundedHistory({
      history,
      budget: { ...BUDGET, maxRecentCharacters: 10 }
    });
    expect(plan.recent).toEqual([]);
    expect(plan.elided).toHaveLength(1);
  });

  it("is deterministic for the same inputs", () => {
    const history = Array.from({ length: 12 }, (_, index) =>
      entry(index + 1, index % 2 === 0 ? "user" : "assistant", `message ${index + 1}`)
    );
    const first = planBoundedHistory({ history, summaries: [summary()], budget: BUDGET });
    const second = planBoundedHistory({ history, summaries: [summary()], budget: BUDGET });
    expect(second).toEqual(first);
  });
});

describe("retrieveElidedHistory", () => {
  it("selects only query-relevant excerpts and bounds them", () => {
    const elided = [
      entry(1, "user", "The deployment region is Frankfurt."),
      entry(2, "assistant", "Unrelated chatter about lunch."),
      entry(3, "user", "Keep the deployment region pinned for the release.")
    ];
    const excerpts = retrieveElidedHistory(elided, "deployment region release", 2, 400);
    expect(excerpts.map((excerpt) => excerpt.sequence)).toEqual([1, 3]);
    for (const excerpt of excerpts) {
      expect(excerpt.text.length).toBeLessThanOrEqual(400);
    }
  });

  it("returns nothing without a query or matches", () => {
    const elided = [entry(1, "user", "alpha")];
    expect(retrieveElidedHistory(elided, undefined)).toEqual([]);
    expect(retrieveElidedHistory(elided, "zzz")).toEqual([]);
  });
});

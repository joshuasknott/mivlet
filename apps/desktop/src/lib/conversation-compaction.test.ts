import { describe, expect, it, vi } from "vitest";
import type { AgentTurnRequest, ContextSummaryRecord } from "@fable/protocol";
import type { ConversationMessageView } from "./conversation-runtime";
import { buildContinuationMessages, continuationMessagesForModel } from "./agent-run";
import {
  compactConversationTurn,
  describeHistoryEntries,
  type CompactionDependencies
} from "./conversation-compaction";

function view(
  sequence: number,
  kind: string,
  content: string,
  detail?: unknown,
  runId?: string
): ConversationMessageView {
  return {
    message: {
      id: `message-${sequence}`,
      threadId: "thread-1",
      sequence,
      kind,
      runId,
      detail
    },
    currentRevision: {
      id: `revision-${sequence}`,
      threadId: "thread-1",
      state: "terminal",
      content
    }
  } as unknown as ConversationMessageView;
}

function historyViews(count: number, size = 240): ConversationMessageView[] {
  return Array.from({ length: count }, (_, index) =>
    view(
      index + 1,
      index % 2 === 0 ? "user" : "assistant",
      `message ${index + 1} ${"detail ".repeat(Math.ceil(size / 7))}`
    )
  );
}

function request(content = "What did we decide about the launch plan?"): AgentTurnRequest {
  return {
    model: "provider-reported-model",
    messages: [{ role: "user", content }],
    tools: [],
    maxTokens: 256
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
    text: "Decisions:\n- The launch window is Friday.",
    sourceMessageIds: Array.from({ length: (overrides.throughSequence ?? 4) - (overrides.fromSequence ?? 1) + 1 }, (_, index) => `message-${index + (overrides.fromSequence ?? 1)}`),
    sourceRevisionIds: Array.from({ length: (overrides.throughSequence ?? 4) - (overrides.fromSequence ?? 1) + 1 }, (_, index) => `revision-${index + (overrides.fromSequence ?? 1)}`),
    derivedMemoryIds: [],
    derivedMemoryRevisions: {},
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides
  };
}

function dependencies(
  summaries: ContextSummaryRecord[] | null,
  save: (record: ContextSummaryRecord) => Promise<ContextSummaryRecord | null> = async (record) => record
): CompactionDependencies {
  return {
    listSummaries: async () => summaries,
    saveSummary: save
  };
}

describe("describeHistoryEntries", () => {
  it("mirrors the replay-safe provider history for ordinary and artifact records", () => {
    const artifact = {
      kind: "computer-artifact",
      version: 1,
      id: `artifact-${"a".repeat(64)}`,
      computerId: `local-${"b".repeat(24)}`,
      title: "Image",
      relativePath: "image.png",
      mimeType: "image/png",
      sizeBytes: 128,
      createdAt: "2026-09-07T12:00:00Z"
    };
    const views = [
      view(1, "user", "Make an image"),
      view(2, "tool", JSON.stringify({ ...artifact, permitId: "old-permit" }), {
        phase: "result",
        toolCallId: "call-1",
        toolName: "write-file",
        outcome: "succeeded"
      }),
      view(3, "tool", "raw tool payload", {
        phase: "result",
        toolCallId: "call-2",
        toolName: "read-file",
        outcome: "succeeded"
      }),
      view(4, "assistant", "Image ready")
    ];
    const entries = describeHistoryEntries(views);
    const expected = continuationMessagesForModel(buildContinuationMessages(views));
    expect(entries.map((entry) => entry.message)).toEqual(expected);
    expect(entries.map((entry) => entry.sequence)).toEqual([1, 2, 4]);
  });
});

describe("compactConversationTurn", () => {
  it("excludes summaries covering another Work or a changed revision", async () => {
    for (const prior of [summary({ fromSequence: 20, throughSequence: 24, text: "UNRELATED FUTURE WORK" }), summary({ text: "STALE REVISION", sourceRevisionIds: ["old-revision"] })]) {
      const save = vi.fn(async (record: ContextSummaryRecord) => record);
      const result = await compactConversationTurn({ threadId: "thread-1", history: describeHistoryEntries(historyViews(14)), request: request(), backendType: "native-api", contextWindowTokens: 20_000, budget: { maxRecentTurns: 2, maxRecentCharacters: 900, maxSummaryCharacters: 4_000, maxRetrievalCharacters: 1_000 }, dependencies: dependencies([prior], save) });
      expect(result.ok).toBe(true);
      if (result.ok) { expect(result.prefix).not.toContain(prior.text); }
      expect(save.mock.calls[0][0].revision).toBe(1);
    }
  });
  it("fails closed when durable summaries are unavailable", async () => {
    const result = await compactConversationTurn({
      threadId: "thread-1",
      history: describeHistoryEntries(historyViews(4)),
      request: request(),
      backendType: "native-api",
      dependencies: dependencies(null)
    });
    expect(result).toMatchObject({ ok: false, code: "compaction-unavailable" });
  });

  it("folds only newly elided entries into a durable revision, then retries bounded", async () => {
    const views = historyViews(14);
    const save = vi.fn(async (record: ContextSummaryRecord) => record);
    const result = await compactConversationTurn({
      threadId: "thread-1",
      history: describeHistoryEntries(views),
      request: request("launch plan detail"),
      contextPrefix: "Base instructions.",
      contextWindowTokens: 3_000,
      backendType: "native-api",
      budget: {
        maxRecentTurns: 2,
        maxRecentCharacters: 900,
        maxSummaryCharacters: 4_000,
        maxRetrievalCharacters: 1_000
      },
      dependencies: dependencies([summary()], save),
      now: "2026-09-11T00:00:00.000Z"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0][0];
    expect(saved.revision).toBe(2);
    expect(saved.fromSequence).toBe(1);
    expect(saved.throughSequence).toBeGreaterThanOrEqual(10);
    expect(saved.text).toContain("launch");
    expect(result.prefix).toContain("Base instructions.");
    expect(result.prefix).toContain("Derived conversation history");
    expect(result.plan.messages.length).toBeLessThan(views.length);
    // The prefix is the bounded remainder, never the lifetime transcript.
    expect(result.prefix.length).toBeLessThan(20_000);
  });

  it("uses a covering summary without writing when it already makes the turn fit", async () => {
    const views = historyViews(12);
    const save = vi.fn(async (record: ContextSummaryRecord) => record);
    const result = await compactConversationTurn({
      threadId: "thread-1",
      history: describeHistoryEntries(views),
      request: request("message detail"),
      contextWindowTokens: 20_000,
      backendType: "native-api",
      budget: {
        maxRecentTurns: 1,
        maxRecentCharacters: 300,
        maxSummaryCharacters: 4_000,
        maxRetrievalCharacters: 1_000
      },
      dependencies: dependencies([summary({ throughSequence: 11 })], save),
      now: "2026-09-11T00:00:00.000Z"
    });
    expect(result.ok).toBe(true);
    expect(save).not.toHaveBeenCalled();
    if (!result.ok) return;
    expect(result.summary?.id).toBe("summary-1");
    expect(result.prefix).toContain("Derived conversation history");
    expect(result.prefix).toContain("Older conversation excerpts");
  });

  it("never returns an unbounded plan when persistence fails", async () => {
    const views = historyViews(14);
    const result = await compactConversationTurn({
      threadId: "thread-1",
      history: describeHistoryEntries(views),
      request: request(),
      contextWindowTokens: 2_000,
      backendType: "native-api",
      budget: {
        maxRecentTurns: 2,
        maxRecentCharacters: 900,
        maxSummaryCharacters: 4_000,
        maxRetrievalCharacters: 1_000
      },
      dependencies: dependencies([], async () => null),
      now: "2026-09-11T00:00:00.000Z"
    });
    expect(result).toMatchObject({ ok: false, code: "compaction-persist-failed" });
    expect(result.ok).toBe(false);
  });

  it("reports still-too-large instead of falling back to the full transcript", async () => {
    const views = historyViews(8, 4_000);
    const result = await compactConversationTurn({
      threadId: "thread-1",
      history: describeHistoryEntries(views),
      request: request("x".repeat(1_200)),
      contextWindowTokens: 300,
      backendType: "native-api",
      budget: {
        maxRecentTurns: 1,
        maxRecentCharacters: 800,
        maxSummaryCharacters: 2_000,
        maxRetrievalCharacters: 500
      },
      dependencies: dependencies([]),
      now: "2026-09-11T00:00:00.000Z"
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["still-too-large", "nothing-to-elide"]).toContain(result.code);
    expect(result.message).toBeTruthy();
  });

  it("requires a thread and history before compacting", async () => {
    const result = await compactConversationTurn({
      threadId: "",
      history: [],
      request: request(),
      backendType: "native-api",
      dependencies: dependencies([])
    });
    expect(result).toMatchObject({ ok: false, code: "compaction-unavailable" });
  });
});

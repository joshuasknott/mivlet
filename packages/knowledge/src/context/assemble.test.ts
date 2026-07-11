import { describe, expect, it } from "vitest";
import type {
  CitationRanking,
  KnowledgeCitation,
  MemoryRecord,
  NativeMessage,
  PinnedContextEntry
} from "@fable/protocol";
import { GLOBAL_SCOPE } from "@fable/protocol";
import { artifactFromRun, assembleContext } from "./assemble";

const NOW = "2026-06-28T12:00:00.000Z";

function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m1",
    kind: "fact",
    title: "Prefers concise answers",
    value: "The user prefers concise answers.",
    source: "chat",
    freshness: "Today",
    approved: true,
    approvalState: "approved",
    pinned: false,
    scope: GLOBAL_SCOPE,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

const ranking: CitationRanking = { relevance: 2, recency: 0.1, authority: 0.1, pin: 0, feedback: 0 };

function makeCitation(overrides: Partial<KnowledgeCitation> = {}): KnowledgeCitation {
  return {
    sourceId: "s1",
    title: "Launch plan",
    snippet: "connector recovery milestone",
    provenance: "Local file - 1.0 KB",
    freshness: "Imported now",
    trust: "untrusted",
    pinned: false,
    score: 2,
    chunkId: "s1#0",
    ranking,
    ...overrides
  };
}

describe("assembleContext — deterministic order", () => {
  it("emits system instructions, memory, then sources in order", () => {
    const assembled = assembleContext({
      runId: "r1",
      systemInstructions: "You are Fable.",
      memory: [makeMemory()],
      citations: [makeCitation()]
    });

    const instrIdx = assembled.systemPrefix.indexOf("You are Fable.");
    const memIdx = assembled.systemPrefix.indexOf("Approved memory");
    const srcIdx = assembled.systemPrefix.indexOf("Relevant sources");
    expect(instrIdx).toBeLessThan(memIdx);
    expect(memIdx).toBeLessThan(srcIdx);
  });

  it("records a contribution reason for each contributed item", () => {
    const assembled = assembleContext({
      runId: "r1",
      systemInstructions: "base",
      memory: [makeMemory()],
      citations: [makeCitation()]
    });
    const reasons = assembled.usage.map((u) => u.reason);
    expect(reasons).toContain("system-instruction");
    expect(reasons).toContain("memory-approved");
    expect(reasons).toContain("retrieved");
  });
});

describe("assembleContext — exclusion", () => {
  it("excludes forgotten memory", () => {
    const forgotten = makeMemory({ id: "m-forgotten", forgottenAt: NOW });
    const live = makeMemory({ id: "m-live" });
    const assembled = assembleContext({ runId: "r1", memory: [forgotten, live], citations: [] });
    expect(assembled.systemPrefix).not.toContain("m-forgotten");
    expect(assembled.usage.find((u) => u.id === "m-forgotten")).toBeUndefined();
    expect(assembled.usage.find((u) => u.id === "m-live")).toBeDefined();
  });

  it("excludes disabled memory", () => {
    const disabled = makeMemory({ id: "m-disabled", disabled: true });
    const assembled = assembleContext({ runId: "r1", memory: [disabled], citations: [] });
    expect(assembled.usage.find((u) => u.id === "m-disabled")).toBeUndefined();
  });

  it("excludes non-approved memory", () => {
    const suggested = makeMemory({ id: "m-sug", approved: false, approvalState: "suggested" });
    const assembled = assembleContext({ runId: "r1", memory: [suggested], citations: [] });
    expect(assembled.usage.find((u) => u.id === "m-sug")).toBeUndefined();
  });

  it("excludes out-of-scope memory", () => {
    const threadMem = makeMemory({
      id: "m-thread",
      scope: { level: "thread", threadId: "t1", projectId: "p1" }
    });
    const assembled = assembleContext({
      runId: "r1",
      scope: GLOBAL_SCOPE,
      memory: [threadMem],
      citations: []
    });
    expect(assembled.usage.find((u) => u.id === "m-thread")).toBeUndefined();
  });

  it("excludes unauthorized sources via the authorization predicate", () => {
    const citation = makeCitation({ sourceId: "source-github-abc", provenance: "Connector: github" });
    const assembled = assembleContext({
      runId: "r1",
      memory: [],
      citations: [citation],
      authorization: { isSourceAuthorized: (connectorId) => connectorId !== "github" }
    });
    expect(assembled.citations).toHaveLength(0);
    expect(assembled.systemPrefix).not.toContain("github");
  });
});

describe("assembleContext — citations + usage", () => {
  it("surfaces citations the user can inspect", () => {
    const assembled = assembleContext({
      runId: "r1",
      memory: [],
      citations: [makeCitation({ chunkId: "s1#0" })]
    });
    expect(assembled.citations).toHaveLength(1);
    expect(assembled.citations[0].chunkId).toBe("s1#0");
  });

  it("captures an immutable versioned receipt with exact ranking and reasons", () => {
    const citation = makeCitation({
      sourceId: "s-receipt",
      ranking: { ...ranking },
      scope: { level: "project", projectId: "p1" }
    });
    const assembled = assembleContext({
      runId: "run-stable",
      assembledAt: NOW,
      scope: { level: "project", projectId: "p1" },
      systemInstructions: "base",
      memory: [makeMemory()],
      citations: [citation]
    });

    expect(assembled.receipt).toEqual({
      version: 1,
      runId: "run-stable",
      assembledAt: NOW,
      scope: { level: "project", projectId: "p1" },
      citations: [expect.objectContaining({
        sourceId: "s-receipt",
        ranking,
        scope: { level: "project", projectId: "p1" }
      })],
      contributions: expect.arrayContaining([
        expect.objectContaining({ reason: "system-instruction" }),
        expect.objectContaining({ reason: "memory-approved" }),
        expect.objectContaining({ reason: "retrieved", citationId: "s1#0" })
      ])
    });
    expect(Object.isFrozen(assembled.receipt)).toBe(true);
    expect(Object.isFrozen(assembled.receipt.citations)).toBe(true);
    expect(Object.isFrozen(assembled.receipt.citations[0].ranking)).toBe(true);
    expect(Object.isFrozen(assembled.receipt.contributions)).toBe(true);

    citation.title = "Changed later";
    citation.ranking!.relevance = 999;
    expect(assembled.receipt.citations[0].title).toBe("Launch plan");
    expect(assembled.receipt.citations[0].ranking.relevance).toBe(2);
  });

  it("does not snapshot excluded inputs in the receipt", () => {
    const assembled = assembleContext({
      runId: "run-exclusions",
      assembledAt: NOW,
      memory: [
        makeMemory({ id: "disabled", disabled: true }),
        makeMemory({ id: "forgotten", forgottenAt: NOW })
      ],
      citations: [makeCitation({ sourceId: "source-github-secret", provenance: "Connector: github" })],
      authorization: { isSourceAuthorized: () => false }
    });

    expect(assembled.receipt.citations).toEqual([]);
    expect(assembled.receipt.contributions).toEqual([]);
  });

  it("rejects missing receipt identity or an invalid assembly timestamp", () => {
    expect(() => assembleContext({ runId: " ", memory: [], citations: [] })).toThrow(/run id/i);
    expect(() => assembleContext({
      runId: "run-valid",
      assembledAt: "not-a-date",
      memory: [],
      citations: []
    })).toThrow(/assembledAt/i);
  });
});

describe("assembleContext — conversation", () => {
  it("carries the latest N turns into messages", () => {
    const messages: NativeMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as NativeMessage["role"],
      content: `msg ${i}`
    }));
    const assembled = assembleContext({
      runId: "r1",
      conversation: messages,
      conversationTurns: 2,
      memory: [],
      citations: []
    });
    // 2 turns * 2 messages = 4 latest.
    expect(assembled.messages).toHaveLength(4);
    expect(assembled.messages[0].content).toBe("msg 16");
  });
});

describe("assembleContext — pinned", () => {
  it("surfaces pinned memory ahead of approved memory", () => {
    const pinned = makeMemory({ id: "m-pin", pinned: true });
    const approved = makeMemory({ id: "m-app" });
    const pinnedEntry: PinnedContextEntry = {
      id: "pe1",
      scope: GLOBAL_SCOPE,
      memoryId: "m-pin",
      pinnedAt: NOW
    };
    const assembled = assembleContext({
      runId: "r1",
      memory: [pinned, approved],
      pinned: [pinnedEntry],
      citations: []
    });
    const pinReason = assembled.usage.find((u) => u.id === "m-pin");
    expect(pinReason?.reason).toBe("pinned");
    expect(assembled.systemPrefix.indexOf("Pinned memory")).toBeLessThan(
      assembled.systemPrefix.indexOf("Approved memory")
    );
  });
});

describe("assembleContext — budget", () => {
  it("stops adding excerpts when the prefix budget is reached", () => {
    const longSnippet = "connector ".repeat(300);
    const citations = Array.from({ length: 20 }, (_, i) =>
      makeCitation({ sourceId: `s${i}`, snippet: longSnippet, chunkId: `s${i}#0` })
    );
    const assembled = assembleContext({
      runId: "r1",
      memory: [],
      citations,
      prefixBudget: 1500
    });
    expect(assembled.systemPrefix.length).toBeLessThan(4000);
  });
});

describe("artifactFromRun", () => {
  it("builds an artifact with provenance back to the run", () => {
    const artifact = artifactFromRun({
      runId: "r1",
      title: "Summary",
      content: "A summary of the work.",
      sourceIds: ["s1"],
      now: NOW
    });
    expect(artifact.id).toBe("art-r1");
    expect(artifact.provenance.runId).toBe("r1");
    expect(artifact.provenance.createdAt).toBe(NOW);
    expect(artifact.provenance.sourceIds).toEqual(["s1"]);
  });
});

import { describe, expect, it } from "vitest";
import type {
  CitationRanking,
  ContextSummaryRecord,
  MemoryRecord,
  NativeMessage,
  PinnedContextEntry,
  ExecutionContextAudience
} from "@mivlet/protocol";
import { GLOBAL_SCOPE } from "@mivlet/protocol";
import { assembleContext } from "./assemble";
import type { AuthorityScopedKnowledgeCitation } from "../retrieval/retrieve";

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

function makeCitation(overrides: Partial<AuthorityScopedKnowledgeCitation> = {}): AuthorityScopedKnowledgeCitation {
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

const PRIVATE_A: ExecutionContextAudience = {
  authority: "local",
  visibility: "member-private",
  actingMemberId: "member-a" as never
};
const SHARED_A: ExecutionContextAudience = {
  authority: "convex",
  visibility: "workspace-shared",
  actingMemberId: "member-a" as never
};
const privateAuthority = (ownerMemberId: string) => ({
  authority: "local" as const,
  visibility: "member-private" as const,
  ownerMemberId: ownerMemberId as never
});
const sharedAuthority = {
  authority: "convex" as const,
  visibility: "workspace-shared" as const
};

describe("assembleContext — deterministic order", () => {
  it("emits system instructions, memory, then sources in order", () => {
    const assembled = assembleContext({
      attemptId: "r1",
      systemInstructions: "You are Mivlet.",
      memory: [makeMemory()],
      citations: [makeCitation()]
    });

    const instrIdx = assembled.systemPrefix.indexOf("You are Mivlet.");
    const memIdx = assembled.systemPrefix.indexOf("Approved memory");
    const srcIdx = assembled.systemPrefix.indexOf("Relevant sources");
    expect(instrIdx).toBeLessThan(memIdx);
    expect(memIdx).toBeLessThan(srcIdx);
  });

  it("records a contribution reason for each contributed item", () => {
    const assembled = assembleContext({
      attemptId: "r1",
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
    const assembled = assembleContext({ attemptId: "r1", memory: [forgotten, live], citations: [] });
    expect(assembled.systemPrefix).not.toContain("m-forgotten");
    expect(assembled.usage.find((u) => u.id === "m-forgotten")).toBeUndefined();
    expect(assembled.usage.find((u) => u.id === "m-live")).toBeDefined();
  });

  it("excludes disabled memory", () => {
    const disabled = makeMemory({ id: "m-disabled", disabled: true });
    const assembled = assembleContext({ attemptId: "r1", memory: [disabled], citations: [] });
    expect(assembled.usage.find((u) => u.id === "m-disabled")).toBeUndefined();
  });

  it("excludes non-approved memory", () => {
    const suggested = makeMemory({ id: "m-sug", approved: false, approvalState: "suggested" });
    const assembled = assembleContext({ attemptId: "r1", memory: [suggested], citations: [] });
    expect(assembled.usage.find((u) => u.id === "m-sug")).toBeUndefined();
  });

  it("excludes out-of-scope memory", () => {
    const threadMem = makeMemory({
      id: "m-thread",
      scope: { level: "thread", threadId: "t1" }
    });
    const assembled = assembleContext({
      attemptId: "r1",
      scope: GLOBAL_SCOPE,
      memory: [threadMem],
      citations: []
    });
    expect(assembled.usage.find((u) => u.id === "m-thread")).toBeUndefined();
  });

  it("excludes unauthorized sources via the authorization predicate", () => {
    const citation = makeCitation({ sourceId: "source-github-abc", provenance: "Connector: github" });
    const assembled = assembleContext({
      attemptId: "r1",
      memory: [],
      citations: [citation],
      authorization: { isSourceAuthorized: (connectorId) => connectorId !== "github" }
    });
    expect(assembled.citations).toHaveLength(0);
    expect(assembled.systemPrefix).not.toContain("github");
  });

  it("binds connector citations and promoted memory to the exact Connection", () => {
    const allowedConnection = "connection-current";
    const citations = [
      makeCitation({
        sourceId: "source-github-current",
        provenance: "Connector: github",
        connectionId: allowedConnection
      }),
      makeCitation({
        sourceId: "source-github-revoked",
        provenance: "Connector: github",
        connectionId: "connection-revoked"
      })
    ];
    const memory = [
      makeMemory({
        id: "memory-current",
        provenance: {
          origin: "source",
          sourceId: "source-github-current",
          connectionId: allowedConnection,
          note: "Imported from GitHub"
        }
      }),
      makeMemory({
        id: "memory-unbound",
        provenance: {
          origin: "source",
          sourceId: "source-github-legacy",
          note: "Legacy connector memory"
        }
      })
    ];
    const assembled = assembleContext({
      attemptId: "run-connection-bound",
      memory,
      citations,
      authorization: {
        isSourceAuthorized: (connectorId, _account, connectionId) =>
          connectorId === "local-files" || connectionId === allowedConnection
      }
    });

    expect(assembled.citations.map((citation) => citation.sourceId)).toEqual([
      "source-github-current"
    ]);
    expect(assembled.usage.map((entry) => entry.id)).toContain("memory-current");
    expect(assembled.usage.map((entry) => entry.id)).not.toContain("memory-unbound");
  });
});

describe("assembleContext — citations + usage", () => {
  it("surfaces citations the user can inspect", () => {
    const assembled = assembleContext({
      attemptId: "r1",
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
      scope: { level: "thread", threadId: "thread-1" }
    });
    const assembled = assembleContext({
      attemptId: "run-stable",
      assembledAt: NOW,
      scope: { level: "thread", threadId: "thread-1" },
      systemInstructions: "base",
      memory: [makeMemory()],
      citations: [citation]
    });

    expect(assembled.receipt).toEqual({
      version: 1,
      attemptId: "run-stable",
      assembledAt: NOW,
      scope: { level: "thread", threadId: "thread-1" },
      citations: [expect.objectContaining({
        sourceId: "s-receipt",
        ranking,
        scope: { level: "thread", threadId: "thread-1" }
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

  it("labels approved thread memory as approved memory", () => {
    const assembled = assembleContext({
      attemptId: "run-project",
      assembledAt: NOW,
      scope: { level: "thread", threadId: "thread-1" },
      memory: [makeMemory({ scope: { level: "thread", threadId: "thread-1" } })],
      citations: []
    });

    expect(assembled.receipt.contributions).toContainEqual(
      expect.objectContaining({ id: "m1", kind: "memory", reason: "memory-approved" })
    );
  });

  it("does not snapshot excluded inputs in the receipt", () => {
    const assembled = assembleContext({
      attemptId: "run-exclusions",
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
    expect(() => assembleContext({ attemptId: " ", memory: [], citations: [] })).toThrow(/attempt id/i);
    expect(() => assembleContext({
      attemptId: "run-valid",
      assembledAt: "not-a-date",
      memory: [],
      citations: []
    })).toThrow(/assembledAt/i);
  });
});

describe("assembleContext — audience privacy", () => {
  it("admits own private and shared memory but excludes another member and missing ownership", () => {
    const assembled = assembleContext({
      attemptId: "run-private-a",
      assembledAt: NOW,
      audience: PRIVATE_A,
      memory: [
        makeMemory({ id: "private-a", authorityScope: privateAuthority("member-a") }),
        makeMemory({ id: "private-b", authorityScope: privateAuthority("member-b") }),
        makeMemory({ id: "shared", authorityScope: sharedAuthority }),
        makeMemory({ id: "legacy-missing" })
      ],
      citations: []
    });

    expect(assembled.receipt.version).toBe(2);
    expect(assembled.usage.map((entry) => entry.id).sort()).toEqual(["private-a", "shared"]);
  });

  it("prevents pinned private memory and private citations from entering a shared run", () => {
    const privateMemory = makeMemory({
      id: "private-pinned",
      pinned: true,
      scope: { level: "thread", threadId: "thread-1" },
      authorityScope: privateAuthority("member-a")
    });
    const pin: PinnedContextEntry = {
      id: "pin-private",
      scope: { level: "thread", threadId: "thread-1" },
      memoryId: privateMemory.id,
      pinnedAt: NOW
    };
    const assembled = assembleContext({
      attemptId: "run-shared",
      assembledAt: NOW,
      scope: { level: "thread", threadId: "thread-1" },
      audience: SHARED_A,
      memory: [
        privateMemory,
        makeMemory({
          id: "shared-memory",
          scope: { level: "thread", threadId: "thread-1" },
          authorityScope: sharedAuthority
        })
      ],
      pinned: [pin],
      citations: [
        makeCitation({
          sourceId: "private-source",
          scope: { level: "thread", threadId: "thread-1" },
          authorityScope: privateAuthority("member-a")
        }),
        makeCitation({
          sourceId: "shared-source",
          scope: { level: "thread", threadId: "thread-1" },
          authorityScope: sharedAuthority
        })
      ]
    });

    expect(assembled.usage.map((entry) => entry.id)).not.toContain("private-pinned");
    expect(assembled.citations.map((citation) => citation.sourceId)).toEqual(["shared-source"]);
    expect(assembled.receipt).toEqual(expect.objectContaining({
      version: 2,
      audience: SHARED_A
    }));
    if (assembled.receipt.version !== 2) throw new Error("Expected a v2 receipt.");
    expect(assembled.receipt.citations[0].authorityScope).toEqual(sharedAuthority);
  });

  it("keeps promotion-derived private memory private", () => {
    const promoted = makeMemory({
      id: "promoted-private",
      kind: "imported",
      authorityScope: privateAuthority("member-a"),
      provenance: { origin: "source", sourceId: "private-source", note: "Approved source" }
    });

    const privateRun = assembleContext({
      attemptId: "run-private-promotion",
      assembledAt: NOW,
      audience: PRIVATE_A,
      memory: [promoted],
      citations: []
    });
    const sharedRun = assembleContext({
      attemptId: "run-shared-promotion",
      assembledAt: NOW,
      audience: SHARED_A,
      memory: [promoted],
      citations: []
    });

    expect(privateRun.usage.map((entry) => entry.id)).toContain("promoted-private");
    expect(sharedRun.usage.map((entry) => entry.id)).not.toContain("promoted-private");
  });

  it("retains v1 legacy behavior only when no audience is supplied", () => {
    const assembled = assembleContext({
      attemptId: "run-legacy",
      assembledAt: NOW,
      memory: [makeMemory({ id: "legacy-missing" })],
      citations: [makeCitation({ sourceId: "legacy-source" })]
    });
    expect(assembled.receipt.version).toBe(1);
    expect(assembled.usage.map((entry) => entry.id)).toEqual(expect.arrayContaining(["legacy-missing", "legacy-source"]));
  });
});

describe("assembleContext — conversation", () => {
  it("carries the latest N turns into messages", () => {
    const messages: NativeMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as NativeMessage["role"],
      content: `msg ${i}`
    }));
    const assembled = assembleContext({
      attemptId: "r1",
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
      attemptId: "r1",
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
      attemptId: "r1",
      memory: [],
      citations,
      prefixBudget: 1500
    });
    expect(assembled.systemPrefix.length).toBeLessThan(4000);
  });

  it("includes a citation whose truncated excerpt fits even when the full snippet would not", () => {
    const citation = makeCitation({ snippet: "x".repeat(600), chunkId: "s1#0" });
    const assembled = assembleContext({
      attemptId: "r1",
      memory: [],
      citations: [citation],
      prefixBudget: 600
    });
    // The full 600-char snippet cannot fit, but the 500-char excerpt does.
    expect(assembled.citations).toHaveLength(1);
    expect(assembled.citations[0].snippet.length).toBe(500);
    expect(assembled.usage.find((u) => u.id === "s1")?.reason).toBe("retrieved");
  });

  it("never lets the excerpt block exceed the prefix budget", () => {
    const snippets = Array.from({ length: 12 }, (_, i) => "connector ".repeat(60));
    const citations = snippets.map((snippet, i) =>
      makeCitation({ sourceId: `s${i}`, snippet, chunkId: `s${i}#0` })
    );
    const assembled = assembleContext({
      attemptId: "r1",
      memory: [],
      citations,
      prefixBudget: 1000
    });
    // Instructions absent: the excerpt block is the entire prefix.
    expect(assembled.systemPrefix.length).toBeLessThanOrEqual(1000);
    // Citations were added only while their lines fit exactly.
    const blockLength = assembled.systemPrefix.length;
    const oneMore = assembleContext({
      attemptId: "r1",
      memory: [],
      citations,
      prefixBudget: blockLength
    });
    expect(oneMore.systemPrefix.length).toBe(blockLength);
  });

  it("includes a line that exactly fills the budget and drops the next", () => {
    const citation = makeCitation({ snippet: "x".repeat(40), chunkId: "s1#0" });
    const probe = assembleContext({
      attemptId: "r1",
      memory: [],
      citations: [citation],
      prefixBudget: 1_000_000
    });
    const exact = probe.systemPrefix.length;
    expect(exact).toBeGreaterThan(0);

    const fits = assembleContext({
      attemptId: "r1",
      memory: [],
      citations: [citation],
      prefixBudget: exact
    });
    expect(fits.citations).toHaveLength(1);
    expect(fits.systemPrefix.length).toBe(exact);

    const tight = assembleContext({
      attemptId: "r1",
      memory: [],
      citations: [citation],
      prefixBudget: exact - 1
    });
    expect(tight.citations).toHaveLength(0);
    expect(tight.systemPrefix).toBe("");
  });

  it("counts large metadata (long titles) toward the budget", () => {
    const longTitle = "A remarkably long title ".repeat(20).trim();
    const shortTitle = "T";
    const assembled = assembleContext({
      attemptId: "r1",
      memory: [],
      citations: [
        makeCitation({ sourceId: "long", title: longTitle, snippet: "x".repeat(30), chunkId: "long#0" }),
        makeCitation({ sourceId: "short", title: shortTitle, snippet: "x".repeat(30), chunkId: "short#0" })
      ],
      prefixBudget: 200
    });
    // The long title's line prefix does not fit; the short one does.
    expect(assembled.citations.map((c) => c.sourceId)).toEqual(["short"]);
  });

  it("carries only the included excerpt on the receipt citation", () => {
    const assembled = assembleContext({
      attemptId: "r1",
      memory: [],
      citations: [makeCitation({ snippet: "y".repeat(700) })],
      prefixBudget: 100_000
    });
    const excerpt = assembled.citations[0].snippet;
    expect(excerpt.length).toBe(500);
    expect(assembled.systemPrefix).toContain(excerpt);
    expect(assembled.systemPrefix).not.toContain("y".repeat(501));
    expect(assembled.receipt.citations[0].snippet).toBe(excerpt);
  });

  it("never splits a surrogate pair when truncating excerpts", () => {
    const assembled = assembleContext({
      attemptId: "r1",
      memory: [],
      citations: [makeCitation({ snippet: "🚀".repeat(300) })],
      prefixBudget: 100_000
    });
    const line = assembled.systemPrefix.split("\n").find((l) => l.includes("["))!;
    expect(line).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(assembled.citations[0].snippet.length).toBeLessThanOrEqual(500);
  });
});

describe("assembleContext — citation scope isolation", () => {
  it("excludes out-of-scope citations from a global run while keeping global ones", () => {
    const assembled = assembleContext({
      attemptId: "r1",
      scope: GLOBAL_SCOPE,
      memory: [],
      citations: [
        makeCitation({ sourceId: "thread-source", scope: { level: "thread", threadId: "t1" } }),
        makeCitation({ sourceId: "global-source" })
      ]
    });
    expect(assembled.citations.map((c) => c.sourceId)).toEqual(["global-source"]);
    expect(assembled.usage.map((u) => u.id)).toEqual(["global-source"]);
  });

  it("admits matching-scope citations into a thread run", () => {
    const scope = { level: "thread" as const, threadId: "t1" };
    const assembled = assembleContext({
      attemptId: "r1",
      scope,
      memory: [],
      citations: [
        makeCitation({ sourceId: "thread-source", scope }),
        makeCitation({ sourceId: "global-source" }),
        makeCitation({ sourceId: "other-thread", scope: { level: "thread" as const, threadId: "t2" } })
      ]
    });
    expect(assembled.citations.map((c) => c.sourceId).sort()).toEqual(["global-source", "thread-source"]);
  });
});

describe("assembleContext — forbidden sources", () => {
  it("a highly ranked forbidden citation never enters context or the receipt", () => {
    const assembled = assembleContext({
      attemptId: "r1",
      memory: [],
      citations: [
        makeCitation({
          sourceId: "source-github-forbidden",
          provenance: "Connector: github",
          score: 9
        }),
        makeCitation({
          sourceId: "source-local-allowed",
          provenance: "Local file - 1.0 KB",
          score: 1
        })
      ],
      authorization: { isSourceAuthorized: (connectorId) => connectorId !== "github" }
    });
    expect(assembled.citations.map((c) => c.sourceId)).toEqual(["source-local-allowed"]);
    expect(assembled.systemPrefix).not.toContain("github");
    expect(assembled.receipt.citations.map((c) => c.sourceId)).toEqual(["source-local-allowed"]);
    expect(assembled.usage.map((u) => u.id)).toEqual(["source-local-allowed"]);
  });
});

describe("assembleContext — derived conversation history", () => {
  const makeSummary = (overrides: Partial<ContextSummaryRecord> = {}): ContextSummaryRecord => ({
    id: "summary-1",
    threadId: "t1",
    scope: { level: "thread", threadId: "t1" },
    fromSequence: 1,
    throughSequence: 8,
    revision: 2,
    text: "User commitments:\n- The launch target is Friday.",
    sourceMessageIds: ["message-1"],
    sourceRevisionIds: ["revision-1"],
    derivedMemoryIds: [],
    derivedMemoryRevisions: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  });

  it("carries live in-scope summaries as untrusted derived evidence", () => {
    const assembled = assembleContext({
      attemptId: "r1",
      scope: { level: "thread", threadId: "t1" },
      memory: [],
      citations: [],
      summaries: [makeSummary()],
      retrievedHistory: [
        {
          messageId: "message-2",
          sequence: 2,
          role: "user",
          text: "Keep the launch window narrow.",
          score: 2
        }
      ]
    });
    expect(assembled.systemPrefix).toContain("launch target is Friday");
    expect(assembled.systemPrefix).toContain("untrusted prior evidence");
    expect(assembled.systemPrefix).toContain("Keep the launch window narrow.");
    expect(assembled.usage).toEqual([
      { id: "summary-1", kind: "summary", reason: "summary" },
      { id: "message-2", kind: "conversation", reason: "history-retrieval" }
    ]);
  });

  it("excludes stale summaries and out-of-scope summaries", () => {
    const assembled = assembleContext({
      attemptId: "r1",
      scope: { level: "thread", threadId: "t1" },
      memory: [],
      citations: [],
      summaries: [
        makeSummary({ id: "stale", staleAt: NOW }),
        makeSummary({ id: "other-thread", scope: { level: "thread", threadId: "t2" } })
      ]
    });
    expect(assembled.systemPrefix).not.toContain("launch target is Friday");
    expect(assembled.usage).toEqual([]);
  });

  it("enforces the derived-history budget", () => {
    const assembled = assembleContext({
      attemptId: "r1",
      memory: [],
      citations: [],
      summaries: [makeSummary({ text: "x".repeat(200) })],
      derivedHistoryBudget: 40
    });
    expect(assembled.usage).toEqual([]);
    expect(assembled.systemPrefix).not.toContain("x".repeat(200));
  });
});

describe("assembleContext — secret-shaped content", () => {
  it("does not copy leaked credentials from retrieved snippets into model context", () => {
    const leaked = "sk-ant-12345678901234567890abc123";
    const assembled = assembleContext({
      attemptId: "r1",
      memory: [],
      citations: [
        makeCitation({
          snippet: `connector recovery milestone bearer ${leaked}`
        })
      ]
    });
    expect(assembled.systemPrefix).toContain("connector recovery milestone");
    expect(assembled.systemPrefix).not.toContain(leaked);
    expect(assembled.citations[0].snippet).not.toContain(leaked);
    expect(assembled.receipt.citations[0].snippet).not.toContain(leaked);
  });
});

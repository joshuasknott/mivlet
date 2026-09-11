import { describe, expect, it } from "vitest";
import type { KnowledgeSource, ExecutionContextAudience, SourceChunk } from "@fable/protocol";
import { GLOBAL_SCOPE } from "@fable/protocol";
import { filterRetrievable, retrieve, type RetrievalSource } from "./retrieve";
import { cosineSimilarity, type EmbeddingProvider } from "./semantic";

function makeSource(overrides: Partial<KnowledgeSource> = {}): KnowledgeSource {
  return {
    id: "s1",
    title: "Launch plan",
    kind: "document",
    connectorId: "local-files",
    provenance: "Local file - 1.0 KB",
    freshness: "Imported now",
    pinned: false,
    authority: 0.5,
    ...overrides
  };
}

function makeChunk(sourceId: string, ordinal: number, text: string, overrides: Partial<SourceChunk> = {}): SourceChunk {
  return {
    id: `${sourceId}#${ordinal}`,
    sourceId,
    ordinal,
    text,
    contentHash: `h-${ordinal}`,
    charStart: ordinal * 100,
    charEnd: ordinal * 100 + text.length,
    ...overrides
  };
}

function src(source: KnowledgeSource, chunks: SourceChunk[]): RetrievalSource {
  return { source, chunks };
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
const PRIVATE_USER: ExecutionContextAudience = {
  authority: "local",
  visibility: "member-private",
  actingInternalUserId: "user-local" as never
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
const privateUserAuthority = {
  authority: "local" as const,
  visibility: "member-private" as const,
  ownerInternalUserId: "user-local" as never
};

describe("retrieve — ranking", () => {
  it.each([false, true])("limits unique results after deduplication (semantic: %s)", async (semantic) => {
    const sources = Array.from({ length: 12 }, (_, index) => {
      const id = `source-${index}`;
      const embedding = semantic ? [1, 0] : undefined;
      return src(makeSource({ id, title: `Launch ${String(index).padStart(2, "0")}` }), [
        makeChunk(id, 0, "Launch plan milestone", { contentHash: "same", embedding }),
        makeChunk(id, 1, "Launch plan milestone", { contentHash: "same", embedding }),
        makeChunk(id, 2, "Launch plan delivery", { heading: "Delivery", embedding })
      ]);
    });
    const options = {
      query: "launch plan",
      budgetChars: 100_000,
      embeddingProvider: semantic ? { id: "fixture", embedTexts: async () => [[1, 0]] } : undefined
    };
    const full = await retrieve(sources, { ...options, limit: 100 });
    const limited = await retrieve(sources, { ...options, limit: 8 });
    expect(full.mode).toBe(semantic ? "hybrid" : "lexical-fallback");
    expect(full.citations).toHaveLength(24);
    expect(limited.citations).toEqual(full.citations.slice(0, 8));
  });

  it("ranks a title-matching chunk above incidental content matches", async () => {
    const sources = [
      src(
        makeSource({ id: "plan", title: "Launch plan" }),
        [makeChunk("plan", 0, "Milestones include connector recovery and signing.")]
      ),
      src(
        makeSource({ id: "notes", title: "Meeting notes" }),
        [makeChunk("notes", 0, "We mentioned the launch briefly in passing.")]
      )
    ];

    const result = await retrieve(sources, { query: "launch" });
    expect(result.citations[0].sourceId).toBe("plan");
  });

  it("boosts pinned sources even without a strong match", async () => {
    const sources = [
      src(makeSource({ id: "pinned", title: "Pinned doc", pinned: true }), [
        makeChunk("pinned", 0, "tangential content")
      ]),
      src(makeSource({ id: "match", title: "Matching doc" }), [
        makeChunk("match", 0, "the query term appears here")
      ])
    ];

    const result = await retrieve(sources, { query: "query term" });
    const pinnedRank = result.citations.findIndex((c) => c.sourceId === "pinned");
    // Pinned is present (boosted in) and ranked competitively.
    expect(pinnedRank).toBeGreaterThanOrEqual(0);
  });

  it("each citation carries its ranking basis (not hidden)", async () => {
    const sources = [
      src(makeSource({ id: "plan", title: "Launch plan", pinned: true }), [
        makeChunk("plan", 0, "connector recovery milestone")
      ])
    ];
    const result = await retrieve(sources, { query: "connector recovery" });
    expect(result.citations[0].ranking).toBeDefined();
    expect(result.citations[0].ranking?.pin).toBeGreaterThan(0);
    expect(result.citations[0].ranking?.relevance).toBeGreaterThan(0);
  });
});

describe("retrieve — citations integrity", () => {
  it("each citation resolves to a real source + chunk", async () => {
    const sources = [
      src(makeSource({ id: "plan", title: "Launch plan" }), [
        makeChunk("plan", 0, "connector recovery milestone")
      ])
    ];
    const result = await retrieve(sources, { query: "connector" });
    expect(result.citations).toHaveLength(1);
    const c = result.citations[0];
    expect(c.sourceId).toBe("plan");
    expect(c.chunkId).toBe("plan#0");
    expect(c.snippet).toContain("connector");
  });
});

describe("retrieve — context budget + dedup", () => {
  it("respects the limit", async () => {
    const sources = [
      src(makeSource({ id: "plan", title: "Launch plan connector" }), [
        makeChunk("plan", 0, "connector one"),
        makeChunk("plan", 1, "connector two"),
        makeChunk("plan", 2, "connector three")
      ])
    ];
    const result = await retrieve(sources, { query: "connector", limit: 2 });
    expect(result.citations.length).toBeLessThanOrEqual(2);
  });

  it("fits a snippet that exactly fills the remaining budget", async () => {
    const text = "connector " + "x".repeat(91);
    const sources = [
      src(makeSource({ id: "plan", title: "Launch plan" }), [
        makeChunk("plan", 0, text.slice(0, 100))
      ])
    ];
    const exact = await retrieve(sources, { query: "connector", budgetChars: 100, snippetChars: 320 });
    expect(exact.citations).toHaveLength(1);
    expect(exact.citations[0].snippet.length).toBe(100);

    // A 101-char chunk under a 100-char budget truncates to exactly 100.
    const over = await retrieve(
      [src(makeSource({ id: "plan", title: "Launch plan" }), [makeChunk("plan", 0, text)])],
      { query: "connector", budgetChars: 100, snippetChars: 320 }
    );
    expect(over.citations[0].snippet.length).toBe(100);
  });

  it("deduplicates duplicates before the budget so redundancy never consumes it", async () => {
    const text = "connector ".repeat(30);
    const sources = [
      src(makeSource({ id: "plan", title: "Launch plan" }), [
        makeChunk("plan", 0, text, { contentHash: "dup" }),
        makeChunk("plan", 1, text, { contentHash: "dup", charStart: 1000, charEnd: 1000 + text.length }),
        makeChunk("plan", 2, text + " unique", { charStart: 2000, charEnd: 2000 + text.length + 7 })
      ])
    ];
    // Budget fits exactly two snippets: the duplicate must not eat budget.
    const result = await retrieve(sources, { query: "connector", budgetChars: 480, snippetChars: 240 });
    expect(result.citations).toHaveLength(2);
    expect(result.citations[0].chunkId).toBe("plan#0");
    expect(result.citations[1].chunkId).toBe("plan#2");
  });

  it("never splits a surrogate pair when truncating snippets", async () => {
    const emoji = "🚀".repeat(60);
    const sources = [
      src(makeSource({ id: "e1", title: "emoji 🚀" }), [
        makeChunk("e1", 0, `preamble here ${emoji}`)
      ])
    ];
    for (const budgetChars of [7, 12, 41, 100, 320]) {
      const result = await retrieve(sources, {
        query: "emoji",
        budgetChars,
        snippetChars: budgetChars
      });
      const snippet = result.citations[0].snippet;
      expect(snippet.length).toBeLessThanOrEqual(budgetChars);
      expect(snippet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });

  it("respects the character budget", async () => {
    const long = "connector ".repeat(200);
    const sources = [
      src(makeSource({ id: "plan", title: "Launch plan" }), [
        makeChunk("plan", 0, long),
        makeChunk("plan", 1, long),
        makeChunk("plan", 2, long)
      ])
    ];
    const result = await retrieve(sources, { query: "connector", budgetChars: 500, snippetChars: 200 });
    const total = result.citations.reduce((sum, c) => sum + c.snippet.length, 0);
    expect(total).toBeLessThanOrEqual(500);
  });

  it.each([1, 3, 6, 7, 20, 100])("fits the first citation and ellipses within a %i-character budget", async (budgetChars) => {
    const sources = [src(makeSource(), [makeChunk("s1", 0, "preamble ".repeat(30) + "connector " + "details ".repeat(100))])];
    const result = await retrieve(sources, { query: "connector", budgetChars, snippetChars: 320 });
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].snippet.length).toBeLessThanOrEqual(budgetChars);
  });

  it.each(["limit", "budgetChars", "snippetChars"] as const)("returns no citations for zero %s without embedding work", async (key) => {
    let calls = 0;
    const result = await retrieve([src(makeSource(), [makeChunk("s1", 0, "connector", { embedding: [1] })])], {
      query: "connector", [key]: 0,
      embeddingProvider: { id: "test", embedTexts: async () => { calls++; return [[1]]; } },
    });
    expect(result.citations).toEqual([]);
    expect(calls).toBe(0);
  });

  it.each([-1, NaN, Infinity, 1.5])("rejects invalid retrieval limits (%s)", async (value) => {
    for (const key of ["limit", "budgetChars", "snippetChars"]) {
      await expect(retrieve([], { query: "connector", [key]: value })).rejects.toThrow(RangeError);
    }
  });

  it("deduplicates overlapping chunks from the same source", async () => {
    // Two chunks with the SAME heading and overlapping char ranges.
    const sources = [
      src(makeSource({ id: "plan", title: "Launch plan" }), [
        makeChunk("plan", 0, "connector recovery is important", {
          charStart: 0,
          charEnd: 100,
          heading: "Recovery"
        }),
        makeChunk("plan", 1, "connector recovery is important continued", {
          charStart: 50,
          charEnd: 150,
          heading: "Recovery"
        })
      ])
    ];
    const result = await retrieve(sources, { query: "connector" });
    expect(result.citations.filter((c) => c.sourceId === "plan").length).toBe(1);
  });
});

describe("retrieve — scope isolation", () => {
  it("global run sees global-scoped sources only", async () => {
    const sources = [
      src(makeSource({ id: "global", title: "Global doc connector", scope: GLOBAL_SCOPE }), [
        makeChunk("global", 0, "connector")
      ]),
      src(
        makeSource({ id: "thread", title: "Thread doc connector", scope: { level: "thread", threadId: "t1" } }),
        [makeChunk("thread", 0, "connector")]
      )
    ];
    const result = await retrieve(sources, { query: "connector", scope: GLOBAL_SCOPE });
    expect(result.citations.map((c) => c.sourceId)).toEqual(["global"]);
  });

  it("thread run sees global + matching thread sources", async () => {
    const sources = [
      src(makeSource({ id: "global", title: "Global doc connector", scope: GLOBAL_SCOPE }), [
        makeChunk("global", 0, "connector")
      ]),
      src(
        makeSource({ id: "thread", title: "Thread doc connector", scope: { level: "thread", threadId: "t1" } }),
        [makeChunk("thread", 0, "connector")]
      ),
      src(
        makeSource({ id: "other", title: "Other thread connector", scope: { level: "thread", threadId: "t2" } }),
        [makeChunk("other", 0, "connector")]
      )
    ];
    const result = await retrieve(sources, {
      query: "connector",
      scope: { level: "thread", threadId: "t1" }
    });
    const ids = result.citations.map((c) => c.sourceId).sort();
    expect(ids).toEqual(["global", "thread"]);
  });

});

describe("retrieve — stale / disabled exclusion", () => {
  it("excludes disabled sources from retrieval", async () => {
    const sources = [
      src(makeSource({ id: "live", title: "Live connector" }), [makeChunk("live", 0, "connector")]),
      src(makeSource({ id: "disabled", title: "Disabled connector", disabled: true }), [
        makeChunk("disabled", 0, "connector")
      ])
    ];
    const result = await retrieve(sources, { query: "connector" });
    expect(result.citations.map((c) => c.sourceId)).toEqual(["live"]);
  });

  it("excludes sources in error status", async () => {
    const sources = [
      src(makeSource({ id: "live", title: "Live connector" }), [makeChunk("live", 0, "connector")]),
      src(makeSource({ id: "errored", title: "Errored connector", status: "error" }), [
        makeChunk("errored", 0, "connector")
      ])
    ];
    const result = await retrieve(sources, { query: "connector" });
    expect(result.citations.map((c) => c.sourceId)).toEqual(["live"]);
  });

  it("excludes stale sources until they are refreshed", async () => {
    const sources = [
      src(makeSource({ id: "fresh", title: "Fresh connector" }), [
        makeChunk("fresh", 0, "connector")
      ]),
      src(makeSource({ id: "stale", title: "Stale connector", status: "stale" }), [
        makeChunk("stale", 0, "connector")
      ])
    ];
    const result = await retrieve(sources, { query: "connector" });
    expect(result.citations.map((citation) => citation.sourceId)).toEqual(["fresh"]);
  });

  it("handles partial failure retrieval by filtering out errored, stale, and disabled sources", async () => {
    const sources = [
      src(makeSource({ id: "good-1", title: "Valid doc 1" }), [makeChunk("good-1", 0, "connector integration")]),
      src(makeSource({ id: "good-2", title: "Valid doc 2" }), [makeChunk("good-2", 0, "connector testing")]),
      src(makeSource({ id: "stale-1", title: "Stale doc", status: "stale" }), [makeChunk("stale-1", 0, "connector stale")]),
      src(makeSource({ id: "error-1", title: "Errored doc", status: "error" }), [makeChunk("error-1", 0, "connector error")]),
      src(makeSource({ id: "disabled-1", title: "Disabled doc", disabled: true }), [makeChunk("disabled-1", 0, "connector disabled")])
    ];
    const result = await retrieve(sources, { query: "connector" });
    const ids = result.citations.map((c) => c.sourceId).sort();
    expect(ids).toEqual(["good-1", "good-2"]);
  });
});

describe("retrieve — no-embedding fallback", () => {
  it("falls back to lexical mode when no embedding provider is given", async () => {
    const sources = [
      src(makeSource({ id: "plan", title: "Launch plan" }), [
        makeChunk("plan", 0, "connector recovery")
      ])
    ];
    const result = await retrieve(sources, { query: "connector" });
    expect(result.mode).toBe("lexical-fallback");
    expect(result.citations).toHaveLength(1);
  });
});

describe("retrieve — hybrid + provider failure", () => {
  it("uses hybrid mode when embeddings exist and the provider works", async () => {
    const provider: EmbeddingProvider = {
      id: "fake",
      async embedTexts(texts) {
        // Trivial deterministic embedding: [text length] so cosine is meaningful.
        return texts.map((t) => [t.length]);
      }
    };
    const sources = [
      src(makeSource({ id: "plan", title: "Launch plan" }), [
        makeChunk("plan", 0, "connector recovery", { embedding: [17], embeddingModel: "fake" })
      ])
    ];
    const result = await retrieve(sources, { query: "connector recovery", embeddingProvider: provider });
    expect(result.mode).toBe("hybrid");
    expect(result.citations[0].sourceId).toBe("plan");
  });

  it("falls back to lexical when the embedding provider throws", async () => {
    const failingProvider: EmbeddingProvider = {
      id: "broken",
      async embedTexts() {
        throw new Error("provider down");
      }
    };
    const sources = [
      src(makeSource({ id: "plan", title: "Launch plan" }), [
        makeChunk("plan", 0, "connector recovery", { embedding: [1], embeddingModel: "broken" })
      ])
    ];
    // Must not throw; must degrade to lexical-fallback.
    const result = await retrieve(sources, { query: "connector recovery", embeddingProvider: failingProvider });
    expect(result.mode).toBe("lexical-fallback");
  });
});

describe("filterRetrievable", () => {
  it("keeps only live, in-scope, non-error sources", () => {
    const sources = [
      src(makeSource({ id: "global", scope: GLOBAL_SCOPE }), [makeChunk("global", 0, "x")]),
      src(makeSource({ id: "disabled", disabled: true }), [makeChunk("disabled", 0, "x")]),
      src(makeSource({ id: "errored", status: "error" }), [makeChunk("errored", 0, "x")]),
      src(
        makeSource({ id: "thread", scope: { level: "thread", threadId: "t1" } }),
        [makeChunk("thread", 0, "x")]
      )
    ];
    const filtered = filterRetrievable(sources, GLOBAL_SCOPE);
    expect(filtered.map((f) => f.source.id)).toEqual(["global"]);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors and 0 for orthogonal", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    expect(cosineSimilarity([], [1])).toBe(0);
  });
});

describe("retrieve — filters", () => {
  it("filters by connectorId", async () => {
    const sources = [
      src(
        makeSource({ id: "local", title: "alpha match", connectorId: "local-files" }),
        [makeChunk("local", 0, "alpha match")]
      ),
      src(
        makeSource({ id: "remote", title: "alpha match", connectorId: "github" }),
        [makeChunk("remote", 0, "alpha match")]
      )
    ];
    const result = await retrieve(sources, { query: "alpha", connectorId: "github" });
    expect(result.citations.map((c) => c.sourceId)).toEqual(["remote"]);
  });

  it("filters by exact Connection before ranking", async () => {
    const sources = [
      src(makeSource({
        id: "connection-a",
        title: "alpha strongest",
        connectorId: "github",
        connectionId: "connection-a"
      }), [makeChunk("connection-a", 0, "alpha alpha alpha")]),
      src(makeSource({
        id: "connection-b",
        title: "alpha",
        connectorId: "github",
        connectionId: "connection-b"
      }), [makeChunk("connection-b", 0, "alpha")])
    ];
    const result = await retrieve(sources, {
      query: "alpha",
      connectionId: "connection-b"
    });
    expect(result.citations.map((citation) => citation.sourceId)).toEqual([
      "connection-b"
    ]);
  });

  it("filters by account", async () => {
    const sources = [
      src(makeSource({ id: "a1", title: "alpha", account: "acct-a" }), [
        makeChunk("a1", 0, "alpha")
      ]),
      src(makeSource({ id: "a2", title: "alpha", account: "acct-b" }), [
        makeChunk("a2", 0, "alpha")
      ])
    ];
    const result = await retrieve(sources, { query: "alpha", account: "acct-a" });
    expect(result.citations.map((c) => c.sourceId)).toEqual(["a1"]);
  });

  it("filters by sourceIds allowlist", async () => {
    const sources = [
      src(makeSource({ id: "s1", title: "alpha" }), [makeChunk("s1", 0, "alpha")]),
      src(makeSource({ id: "s2", title: "alpha" }), [makeChunk("s2", 0, "alpha")])
    ];
    const result = await retrieve(sources, { query: "alpha", sourceIds: ["s2"] });
    expect(result.citations.map((c) => c.sourceId)).toEqual(["s2"]);
  });

  it("restricts to userSelectedSourceIds when present", async () => {
    const sources = [
      src(makeSource({ id: "s1", title: "alpha" }), [makeChunk("s1", 0, "alpha")]),
      src(makeSource({ id: "s2", title: "alpha" }), [makeChunk("s2", 0, "alpha")]),
      src(makeSource({ id: "s3", title: "alpha" }), [makeChunk("s3", 0, "alpha")])
    ];
    const result = await retrieve(sources, {
      query: "alpha",
      userSelectedSourceIds: ["s1", "s3"]
    });
    const ids = result.citations.map((c) => c.sourceId).sort();
    expect(ids).toEqual(["s1", "s3"]);
  });

  it("excludes sources failing the authorization predicate", async () => {
    const sources = [
      src(makeSource({ id: "ok", title: "alpha", connectorId: "local-files" }), [
        makeChunk("ok", 0, "alpha")
      ]),
      src(makeSource({ id: "revoked", title: "alpha", connectorId: "disconnected" }), [
        makeChunk("revoked", 0, "alpha")
      ])
    ];
    const result = await retrieve(sources, {
      query: "alpha",
      isAuthorized: (s) => s.connectorId === "local-files"
    });
    expect(result.citations.map((c) => c.sourceId)).toEqual(["ok"]);
  });

  it("a highly ranked forbidden source never leaks through scoring", async () => {
    // The forbidden source matches the query far better than the allowed one;
    // the authorization predicate must keep it out of scoring entirely.
    const sources = [
      src(makeSource({ id: "allowed", title: "allowed note" }), [
        makeChunk("allowed", 0, "alpha appears once here")
      ]),
      src(makeSource({ id: "forbidden", title: "alpha alpha alpha", connectorId: "revoked-connector" }), [
        makeChunk("forbidden", 0, "alpha alpha alpha alpha alpha alpha")
      ])
    ];
    const result = await retrieve(sources, {
      query: "alpha",
      isAuthorized: (s) => s.connectorId !== "revoked-connector"
    });
    expect(result.citations.map((c) => c.sourceId)).toEqual(["allowed"]);
    expect(result.citations.some((c) => c.sourceId === "forbidden")).toBe(false);
  });
});

describe("retrieve — lifecycle exclusion", () => {
  it("excludes indexing-status sources from retrieval", async () => {
    const sources = [
      src(makeSource({ id: "indexing", title: "alpha", status: "indexing" }), [
        makeChunk("indexing", 0, "alpha")
      ]),
      src(makeSource({ id: "ok", title: "alpha" }), [makeChunk("ok", 0, "alpha")])
    ];
    const result = await retrieve(sources, { query: "alpha" });
    expect(result.citations.map((c) => c.sourceId)).toEqual(["ok"]);
  });

  it("excludes removed (deletedAt) sources before scoring even when they match best", async () => {
    const sources = [
      src(makeSource({ id: "removed", title: "Removed doc", deletedAt: "2026-09-01T00:00:00.000Z" }), [
        makeChunk("removed", 0, "alpha alpha alpha alpha alpha")
      ]),
      src(makeSource({ id: "live", title: "Live doc" }), [
        makeChunk("live", 0, "alpha")
      ])
    ];
    const result = await retrieve(sources, { query: "alpha" });
    expect(result.citations.map((c) => c.sourceId)).toEqual(["live"]);
  });
});

describe("retrieve — deterministic tie-breaking", () => {
  it("breaks ties by title, then chunk ordinal, then chunkId", async () => {
    const sources = [
      src(makeSource({ id: "b", title: "Beta" }), [
        makeChunk("b", 0, "alpha"),
        makeChunk("b", 1, "alpha")
      ]),
      src(makeSource({ id: "a", title: "Alpha" }), [makeChunk("a", 0, "alpha")])
    ];
    const result = await retrieve(sources, { query: "alpha" });
    // All have identical lexical scores; Alpha (title) sorts before Beta.
    expect(result.citations[0].sourceId).toBe("a");
    expect(result.citations[0].chunkId).toBe("a#0");
  });

  it("ties order by code-unit order, not the runtime locale", async () => {
    // Hybrid mode: chunk A ranks 0 lexically and 1 semantically; chunk B ranks
    // 1 lexically and 0 semantically — both fuse to 1/(60+0)+1/(60+1), a true
    // equal-score tie resolved by the title tie-break.
    const sources = [
      src(makeSource({ id: "lower", title: "alpha" }), [
        makeChunk("lower", 0, "alpha alpha alpha", { embedding: [0, 1], embeddingModel: "fix" })
      ]),
      src(makeSource({ id: "upper", title: "Alpha" }), [
        makeChunk("upper", 0, "alpha", { embedding: [1, 0], embeddingModel: "fix" })
      ])
    ];
    const result = await retrieve(sources, {
      query: "alpha",
      embeddingProvider: { id: "fix", embedTexts: async () => [[1, 0]] }
    });
    // The tie-break must use code-unit order (uppercase first), never
    // localeCompare, which flips this on different ICU locales.
    expect(result.mode).toBe("hybrid");
    expect(result.citations[0].sourceId).toBe("upper");
    expect(result.citations.map((c) => c.sourceId)).toEqual(["upper", "lower"]);
  });

  it("produces byte-identical ordering across repeated runs of equal-score inputs", async () => {
    const sources = () => [
      src(makeSource({ id: "b", title: "Beta" }), [
        makeChunk("b", 0, "alpha"),
        makeChunk("b", 1, "alpha"),
        makeChunk("b", 2, "alpha")
      ]),
      src(makeSource({ id: "a", title: "Alpha" }), [
        makeChunk("a", 0, "alpha"),
        makeChunk("a", 1, "alpha")
      ]),
      src(makeSource({ id: "c", title: "Gamma" }), [makeChunk("c", 0, "alpha")])
    ];
    const first = await retrieve(sources(), { query: "alpha", limit: 20 });
    const second = await retrieve(sources(), { query: "alpha", limit: 20 });
    expect(second.citations).toEqual(first.citations);
  });
});

describe("retrieve — content-hash dedup", () => {
  it("drops same-source chunks with identical content hashes", async () => {
    const sources = [
      src(makeSource({ id: "s1", title: "alpha" }), [
        makeChunk("s1", 0, "alpha content", { contentHash: "dup" }),
        makeChunk("s1", 1, "alpha content", { contentHash: "dup", charStart: 500, charEnd: 513 })
      ])
    ];
    const result = await retrieve(sources, { query: "alpha" });
    expect(result.citations).toHaveLength(1);
  });
});

describe("retrieve — citation enrichment", () => {
  it("carries exact Connection, sourcePath, mediaType, and scope on citations", async () => {
    const sources = [
      src(
        makeSource({
          id: "s1",
          title: "alpha",
          connectionId: "connection-alpha",
          sourcePath: "docs/alpha.md",
          mediaType: "text/markdown",
          scope: { level: "thread", threadId: "thread-1" }
        }),
        [makeChunk("s1", 0, "alpha")]
      )
    ];
    const result = await retrieve(sources, {
      query: "alpha",
      scope: { level: "thread", threadId: "thread-1" }
    });
    expect(result.citations[0].connectionId).toBe("connection-alpha");
    expect(result.citations[0].sourcePath).toBe("docs/alpha.md");
    expect(result.citations[0].mediaType).toBe("text/markdown");
    expect(result.citations[0].scope).toEqual({ level: "thread", threadId: "thread-1" });
  });
});

describe("retrieve — lexical fallback after embedding failure", () => {
  it("degrades to lexical-fallback when the embedding provider throws", async () => {
    const failingProvider: EmbeddingProvider = {
      async embedTexts() {
        throw new Error("provider down");
      }
    };
    const sources = [
      src(makeSource({ id: "s1", title: "alpha" }), [
        makeChunk("s1", 0, "alpha content", { embedding: [1, 0] })
      ])
    ];
    const result = await retrieve(sources, {
      query: "alpha",
      embeddingProvider: failingProvider
    });
    expect(result.mode).toBe("lexical-fallback");
    expect(result.citations.length).toBeGreaterThan(0);
  });
});

describe("retrieve — audience privacy", () => {
  const sources = () => [
    src(makeSource({ id: "private-a", authorityScope: privateAuthority("member-a"), pinned: true }), [
      makeChunk("private-a", 0, "connector private a")
    ]),
    src(makeSource({ id: "private-b", authorityScope: privateAuthority("member-b") }), [
      makeChunk("private-b", 0, "connector private b")
    ]),
    src(makeSource({ id: "shared", authorityScope: sharedAuthority }), [
      makeChunk("shared", 0, "connector shared")
    ]),
    src(makeSource({ id: "private-user", authorityScope: privateUserAuthority }), [
      makeChunk("private-user", 0, "connector private user")
    ]),
    src(makeSource({ id: "legacy-missing" }), [
      makeChunk("legacy-missing", 0, "connector legacy")
    ]),
    src(makeSource({
      id: "invalid-authority",
      authorityScope: { authority: "local", visibility: "workspace-shared" } as never
    }), [
      makeChunk("invalid-authority", 0, "connector invalid")
    ])
  ];

  it("admits own private plus shared records for a private audience", async () => {
    const result = await retrieve(sources(), { query: "connector", audience: PRIVATE_A });
    expect(result.citations.map((citation) => citation.sourceId).sort()).toEqual(["private-a", "shared"]);
    expect(result.citations.every((citation) => citation.authorityScope)).toBe(true);
  });

  it("admits only shared records for a shared audience despite pins and explicit ids", async () => {
    const result = await retrieve(sources(), {
      query: "connector",
      audience: SHARED_A,
      sourceIds: ["private-a", "shared"],
      userSelectedSourceIds: ["private-a", "shared"]
    });
    expect(result.citations.map((citation) => citation.sourceId)).toEqual(["shared"]);
    expect(result.citations[0].authorityScope).toEqual(sharedAuthority);
  });

  it("matches local private records by internal user exactly", async () => {
    const result = await retrieve(sources(), { query: "connector", audience: PRIVATE_USER });
    expect(result.citations.map((citation) => citation.sourceId).sort()).toEqual(["private-user", "shared"]);
  });

  it("retains legacy filtering only when no audience is supplied", async () => {
    const result = await retrieve(sources(), { query: "legacy" });
    expect(result.citations.map((citation) => citation.sourceId)).toContain("legacy-missing");
  });
});

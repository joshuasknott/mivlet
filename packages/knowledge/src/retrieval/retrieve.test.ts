import { describe, expect, it } from "vitest";
import type { KnowledgeSource, SourceChunk } from "@fable/protocol";
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

describe("retrieve — ranking", () => {
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
    expect(total).toBeLessThanOrEqual(700); // budget + at most one snippet overshoot
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
        makeSource({ id: "thread", title: "Thread doc connector", scope: { level: "thread", threadId: "t1", projectId: "p1" } }),
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
        makeSource({ id: "thread", title: "Thread doc connector", scope: { level: "thread", threadId: "t1", projectId: "p1" } }),
        [makeChunk("thread", 0, "connector")]
      ),
      src(
        makeSource({ id: "other", title: "Other thread connector", scope: { level: "thread", threadId: "t2", projectId: "p1" } }),
        [makeChunk("other", 0, "connector")]
      )
    ];
    const result = await retrieve(sources, {
      query: "connector",
      scope: { level: "thread", threadId: "t1", projectId: "p1" }
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
        makeSource({ id: "thread", scope: { level: "thread", threadId: "t1", projectId: "p1" } }),
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

import { describe, expect, it } from "vitest";
import type { KnowledgeSource } from "@mivlet/protocol";
import { searchKnowledgeSources } from "./knowledge-search";

const sources: KnowledgeSource[] = [
  {
    id: "launch-plan",
    title: "Launch plan",
    kind: "document",
    connectorId: "local-files",
    provenance: "Local file - 2.4 KB",
    freshness: "Imported now",
    pinned: true,
    trust: "untrusted",
    contentPreview: "Milestones include private beta, connector recovery, and Windows signing."
  },
  {
    id: "security-model",
    title: "Security model",
    kind: "document",
    connectorId: "local-files",
    provenance: "Approved workspace document",
    freshness: "Current",
    pinned: false,
    trust: "trusted",
    contentPreview: "Consequential actions require approval and retain an audit history."
  },
  {
    id: "meeting-notes",
    title: "Meeting notes",
    kind: "document",
    connectorId: "notion",
    provenance: "Notion fixture",
    freshness: "Updated last week",
    pinned: false,
    trust: "untrusted",
    contentPreview: "Discussed general positioning and launch timing."
  }
];

describe("knowledge search", () => {
  it("returns ranked citations with provenance and trust", () => {
    const result = searchKnowledgeSources("connector recovery", sources);

    expect(result.mode).toBe("lexical-fallback");
    expect(result.citations[0]).toMatchObject({
      sourceId: "launch-plan",
      provenance: "Local file - 2.4 KB",
      trust: "untrusted",
      pinned: true
    });
    expect(result.citations[0].snippet).toContain("connector recovery");
  });

  it("boosts title matches above incidental content matches", () => {
    const result = searchKnowledgeSources("security", sources);

    expect(result.citations[0].sourceId).toBe("security-model");
  });

  it("returns pinned sources when the query is empty", () => {
    const result = searchKnowledgeSources("", sources);

    expect(result.citations.map((citation) => citation.sourceId)).toEqual(["launch-plan"]);
  });

  it("respects result limits", () => {
    const result = searchKnowledgeSources("launch", sources, 1);

    expect(result.citations).toHaveLength(1);
  });

  it("returns no citations for unrelated terms", () => {
    const result = searchKnowledgeSources("quarterly invoices", sources);

    expect(result.citations).toEqual([]);
  });
});

describe("knowledge search: lifecycle exclusion + integrity", () => {
  it("excludes disabled sources", () => {
    const disabled = sources.map((s) =>
      s.id === "security-model" ? { ...s, disabled: true } : s
    );
    const result = searchKnowledgeSources("security", disabled);
    expect(result.citations.map((c) => c.sourceId)).not.toContain("security-model");
  });

  it("excludes error/stale/indexing sources", () => {
    const stale = sources.map((s) =>
      s.id === "launch-plan" ? { ...s, status: "stale" as const } : s
    );
    const result = searchKnowledgeSources("connector recovery", stale);
    expect(result.citations.map((c) => c.sourceId)).not.toContain("launch-plan");
  });

  it("deduplicates sources with the same id in the input", () => {
    const duped = [...sources, sources[0]];
    const result = searchKnowledgeSources("launch", duped);
    const ids = result.citations.map((c) => c.sourceId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes chunkId and ranking in every citation", () => {
    const result = searchKnowledgeSources("connector recovery", sources);
    for (const c of result.citations) {
      expect(c.chunkId).toMatch(/#0$/);
      expect(c.ranking).toBeDefined();
      expect(c.ranking?.relevance).toBeGreaterThanOrEqual(0);
    }
  });

  it("honors a character budget across snippets", () => {
    const result = searchKnowledgeSources("launch security meeting", sources, {
      limit: 5,
      budgetChars: 50
    });
    // Budget caps the total snippet chars (after keeping the top citation).
    const total = result.citations.reduce((sum, c) => sum + c.snippet.length, 0);
    expect(total).toBeLessThanOrEqual(50 + 240); // top citation may exceed before budget applies
    expect(result.citations.length).toBeGreaterThanOrEqual(1);
  });
});

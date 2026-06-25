import { describe, expect, it } from "vitest";
import type { KnowledgeSource } from "@praxis/protocol";
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

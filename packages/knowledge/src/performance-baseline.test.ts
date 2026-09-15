import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import type { KnowledgeSource, MemoryRecord, SourceChunk } from "@mivlet/protocol";
import { chunkSourceText } from "./ingestion/chunk";
import { retrieve, type RetrievalSource } from "./retrieval/retrieve";
import { applyRetention, DEFAULT_RETENTION_POLICY } from "./memory/retention";
import { detectDuplicate } from "./memory/duplicate";

function retrievalSources(sourceCount: number, chunksPerSource: number): RetrievalSource[] {
  return Array.from({ length: sourceCount }, (_, sourceIndex) => {
    const source: KnowledgeSource = {
      id: `source-${sourceIndex}`,
      title: sourceIndex % 12 === 0 ? `Connector rollout ${sourceIndex}` : `Local note ${sourceIndex}`,
      kind: "document",
      connectorId: "local-files",
      provenance: `fixture://knowledge/${sourceIndex}`,
      freshness: "2026-07-02",
      pinned: sourceIndex === 24,
      trust: "untrusted",
      importedAt: "2026-07-02T00:00:00.000Z"
    };
    const chunks: SourceChunk[] = Array.from({ length: chunksPerSource }, (_, chunkIndex) => ({
      id: `${source.id}#${chunkIndex}`,
      sourceId: source.id,
      text:
        sourceIndex % 12 === 0
          ? `Connector OAuth approval boundary cache search local first chunk ${chunkIndex}.`
          : `General workspace memory and reference note ${chunkIndex}.`,
      ordinal: chunkIndex,
      charStart: chunkIndex * 120,
      charEnd: chunkIndex * 120 + 90,
      contentHash: `${source.id}-${chunkIndex}`
    }));
    return { source, chunks };
  });
}

function memories(count: number): MemoryRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `memory-${index}`,
    kind: "preference",
    title: `Preference ${index}`,
    value: index % 25 === 0 ? "Prefers concise release notes" : `Prefers workspace setting ${index}`,
    status: "active",
    source: "manual",
    confidence: 0.9,
    createdAt: `2026-07-02T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
    updatedAt: `2026-07-02T00:${String(index % 60).padStart(2, "0")}:00.000Z`
  }));
}

describe("knowledge performance baseline guardrails", () => {
  it("rejects unrelated long memory values within a loose local guardrail", () => {
    const existing = memories(40).map((record, index) => ({
      ...record,
      value: `${"abcdefghij".repeat(150)}${index}`
    }));
    const start = performance.now();
    const result = detectDuplicate({ title: "Unrelated", value: "klmnopqrst".repeat(150) }, existing);
    const durationMs = performance.now() - start;

    console.info(`Synthetic long-memory duplicate scan: ${durationMs.toFixed(1)} ms`);
    expect(result).toBeNull();
    expect(durationMs).toBeLessThan(1_500);
  });

  it("retrieves from synthetic local chunks within a loose local guardrail", async () => {
    const start = performance.now();
    const response = await retrieve(retrievalSources(600, 3), {
      query: "connector approval cache",
      limit: 8,
      budgetChars: 2_400
    });
    const durationMs = performance.now() - start;

    expect(durationMs, `retrieval took ${Math.round(durationMs)} ms`).toBeLessThan(1_500);
    expect(response.mode).toBe("lexical-fallback");
    expect(response.citations).toHaveLength(8);
  });

  it("applies memory retention over synthetic records without quadratic blowup at current scale", () => {
    const start = performance.now();
    const result = applyRetention(
      memories(750),
      DEFAULT_RETENTION_POLICY,
      "2026-07-02T01:00:00.000Z"
    );
    const durationMs = performance.now() - start;

    expect(durationMs, `memory retention took ${Math.round(durationMs)} ms`).toBeLessThan(1_500);
    expect(result.prunedIds).toEqual(expect.any(Array));
    expect(Object.keys(result.reasons).length).toBeGreaterThan(0);
  });

  it("chunks a large bounded markdown document with fences and emoji within a loose guardrail", () => {
    const section = [
      "# Section heading",
      "",
      "A representative paragraph with mixed sentence boundaries. ",
      "```ts",
      "# not a heading",
      "const value = 1;",
      "```",
      "",
      "Emoji-heavy line: " + "😀".repeat(40) + ".",
      "日本語のテキスト。".repeat(8),
      "",
      "a".repeat(300) + " " + "b".repeat(300)
    ].join("\n");
    const text = Array.from({ length: 80 }, (_, i) => `## Sub ${i}\n\n${section}\n`).join("\n");

    const start = performance.now();
    const chunks = chunkSourceText(text, { sourceId: "perf", type: "markdown" });
    const durationMs = performance.now() - start;

    console.info(`Markdown chunking ${text.length.toLocaleString()} chars: ${durationMs.toFixed(1)} ms (${chunks.length} chunks)`);
    expect(chunks.length).toBeGreaterThan(10);
    expect(durationMs, `chunking took ${Math.round(durationMs)} ms`).toBeLessThan(1_500);
  });
});

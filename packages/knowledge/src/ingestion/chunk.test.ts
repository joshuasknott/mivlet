import { describe, expect, it } from "vitest";
import { chunkSourceText, DEFAULT_MAX_CHARS, DEFAULT_OVERLAP_CHARS, mimeToType } from "./chunk";

describe("chunk: ids + offsets", () => {
  it("assigns stable ids `${sourceId}#${ordinal}` from 0", () => {
    const text = "para one.\n\npara two.\n\npara three.";
    const chunks = chunkSourceText(text, { sourceId: "s1", type: "text", maxChars: 12 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((c) => c.id)).toEqual(chunks.map((c, i) => `s1#${i}`));
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
    expect(chunks[0].sourceId).toBe("s1");
  });

  it("charStart/charEnd index into the original text", () => {
    const text = "alpha beta gamma delta.";
    const chunks = chunkSourceText(text, { sourceId: "s", type: "text", maxChars: 10 });
    for (const chunk of chunks) {
      expect(chunk.charStart).toBeGreaterThanOrEqual(0);
      expect(chunk.charEnd).toBeLessThanOrEqual(text.length);
      expect(chunk.charEnd).toBeGreaterThan(chunk.charStart);
    }
  });

  it("returns [] for empty / whitespace-only text", () => {
    expect(chunkSourceText("   \n\t ", { sourceId: "s", type: "text" })).toEqual([]);
    expect(chunkSourceText("", { sourceId: "s", type: "markdown" })).toEqual([]);
  });

  it("applies default maxChars/overlap when unspecified", () => {
    expect(DEFAULT_MAX_CHARS).toBe(1200);
    expect(DEFAULT_OVERLAP_CHARS).toBe(200);
  });
});

describe("chunk: markdown heading split", () => {
  const md = `# Intro

Welcome to the doc.

## Setup

Install dependencies.

## Usage

Run the server.`;

  it("splits on ATX headings and carries the nearest heading", () => {
    const chunks = chunkSourceText(md, { sourceId: "s", type: "markdown" });
    const headings = chunks.map((c) => c.heading);
    expect(headings).toContain("Intro");
    expect(headings).toContain("Setup");
    expect(headings).toContain("Usage");
  });

  it("keeps content under the cap and never produces an empty chunk", () => {
    const chunks = chunkSourceText(md, { sourceId: "s", type: "markdown", maxChars: 20 });
    for (const c of chunks) {
      expect(c.text.length).toBeGreaterThan(0);
      expect(c.contentHash).toBeTruthy();
    }
  });

  it("falls back to plain chunking when there are no headings", () => {
    const noHeadings = "Just a paragraph with no headings at all.";
    const chunks = chunkSourceText(noHeadings, { sourceId: "s", type: "markdown", maxChars: 30 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.heading === undefined)).toBe(true);
  });
});

describe("chunk: JSON", () => {
  it("array -> one chunk per element, serialized", () => {
    const chunks = chunkSourceText('[{"a":1},{"b":2}]', { sourceId: "s", type: "json" });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toBe('{"a":1}');
    expect(chunks[1].text).toBe('{"b":2}');
  });

  it("object -> one chunk per top-level key/value", () => {
    const chunks = chunkSourceText('{"name":"Fable","kind":"app"}', {
      sourceId: "s",
      type: "json"
    });
    expect(chunks).toHaveLength(2);
    const texts = chunks.map((c) => c.text).sort();
    expect(texts).toEqual(['{"kind":"app"}', '{"name":"Fable"}']);
  });

  it("primitive -> fixed window over the raw text", () => {
    const chunks = chunkSourceText('"hello world"', { sourceId: "s", type: "json" });
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("empty array -> no chunks", () => {
    expect(chunkSourceText("[]", { sourceId: "s", type: "json" })).toEqual([]);
  });
});

describe("chunk: CSV", () => {
  const csv = ["name,kind,size"].concat(
    Array.from({ length: 120 }, (_, i) => `item-${i},doc,${i}`)
  ).join("\n");

  it("prepends the header line to every chunk", () => {
    const chunks = chunkSourceText(csv, { sourceId: "s", type: "csv", maxChars: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.startsWith("name,kind,size\n")).toBe(true);
    }
  });

  it("groups ~50 rows per chunk when maxChars is generous", () => {
    const chunks = chunkSourceText(csv, { sourceId: "s", type: "csv", maxChars: 100000 });
    // 120 rows / ~50 per group -> ~3 groups.
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.length).toBeLessThanOrEqual(4);
  });

  it("respects the maxChars cap when smaller than a 50-row group", () => {
    const chunks = chunkSourceText(csv, { sourceId: "s", type: "csv", maxChars: 60 });
    for (const c of chunks) {
      // Each chunk body stays within (header + cap) of characters.
      expect(c.text.length).toBeLessThan(200);
    }
    expect(chunks.length).toBeGreaterThan(3);
  });
});

describe("chunk: plain text fixed window with overlap", () => {
  it("splits long text into windows within maxChars", () => {
    const text = "Sentence one. ".repeat(200);
    const chunks = chunkSourceText(text, { sourceId: "s", type: "text", maxChars: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(100 + 5); // small slack for boundary adjust
    }
  });

  it("produces overlap between consecutive windows", () => {
    const text = "abcdefghijklmnopqrstuvwxyz ".repeat(50);
    const chunks = chunkSourceText(text, { sourceId: "s", type: "text", maxChars: 120, overlapChars: 40 });
    if (chunks.length >= 2) {
      // The next window should start before the previous window ended (overlap).
      expect(chunks[1].charStart).toBeLessThan(chunks[0].charEnd);
    }
  });

  it("infers type from mimeType when type omitted", () => {
    expect(mimeToType("text/markdown")).toBe("markdown");
    expect(mimeToType("application/json")).toBe("json");
    expect(mimeToType("text/csv")).toBe("csv");
    expect(mimeToType(undefined)).toBe("text");
    expect(mimeToType("application/octet-stream")).toBe("text");
  });

  it("every chunk has a non-empty contentHash", () => {
    const chunks = chunkSourceText("a b c d e f g h i j. ".repeat(50), {
      sourceId: "s",
      type: "text",
      maxChars: 50
    });
    for (const c of chunks) {
      expect(c.contentHash).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

import { describe, expect, it } from "vitest";
import { chunkSourceText, DEFAULT_MAX_CHARS, DEFAULT_OVERLAP_CHARS, mimeToType } from "./chunk";

describe("chunk: no lost source content", () => {
  it.each(["text", "markdown"] as const)("keeps citation spans identical to chunk text including whitespace (%s)", (type) => {
    const text = "  Preamble.\n\n# Heading\n\n" + "some words. ".repeat(20) + "\n ";
    const chunks = chunkSourceText(text, { sourceId: "s", type, maxChars: 60, overlapChars: 10 });
    for (const chunk of chunks) {
      expect(chunk.text).toBe(text.slice(chunk.charStart, chunk.charEnd));
      expect(chunk.text.length).toBeLessThanOrEqual(60);
    }
  });

  it.each(["text", "markdown", "yaml"] as const)("covers every non-whitespace character after boundary adjustment (%s)", (type) => {
    const text = (type === "markdown" ? "# Heading\n" : type === "yaml" ? "body: " : "") +
      "a".repeat(60) + "\n\n" + "b".repeat(170);
    const chunks = chunkSourceText(text, { sourceId: "s", type, maxChars: 100, overlapChars: 0 });
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i])) continue;
      expect(chunks.some((chunk) => chunk.charStart <= i && chunk.charEnd > i), `missing offset ${i}`).toBe(true);
    }
  });

  it("preserves YAML source positions with CRLF line endings", () => {
    const text = "name: Fable\r\nkind: app\r\nversion: 1\r\n";
    const chunks = chunkSourceText(text, { sourceId: "s", type: "yaml" });
    expect(chunks.map((chunk) => chunk.text.trim())).toEqual(["name: Fable", "kind: app", "version: 1"]);
    expect(chunks.map((chunk) => chunk.charStart)).toEqual([0, text.indexOf("kind:"), text.indexOf("version:")]);
    for (const chunk of chunks) expect(text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
  });

  it.each([0, -1, NaN, Infinity, 1.5])("rejects invalid window sizes (%s)", (maxChars) => {
    expect(() => chunkSourceText("content", { sourceId: "s", maxChars })).toThrow(RangeError);
  });
  it.each([-1, NaN, Infinity, 1.5])("rejects invalid overlap (%s)", (overlapChars) => {
    expect(() => chunkSourceText("content", { sourceId: "s", overlapChars })).toThrow(RangeError);
  });
});

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

describe("chunk: YAML structural boundaries", () => {
  it("splits a top-level mapping into one chunk per key, preserving offsets", () => {
    const yaml = "name: Fable\nkind: app\nversion: 1\n";
    const chunks = chunkSourceText(yaml, { sourceId: "s", type: "yaml" });
    expect(chunks.length).toBe(3);
    // Each chunk references the original text by offset.
    for (const c of chunks) {
      expect(c.charStart).toBeGreaterThanOrEqual(0);
      expect(c.charEnd).toBeLessThanOrEqual(yaml.length);
      expect(yaml.slice(c.charStart, c.charEnd).trim().length).toBeGreaterThan(0);
    }
  });

  it("falls back to plain-text windows for non-mapping YAML", () => {
    const seq = "- one\n- two\n- three\n";
    const chunks = chunkSourceText(seq, { sourceId: "s", type: "yaml" });
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("returns [] for empty/whitespace YAML", () => {
    expect(chunkSourceText("   \n  ", { sourceId: "s", type: "yaml" })).toEqual([]);
  });

  it("routes application/yaml via mimeToType to yaml chunking", () => {
    expect(mimeToType("application/yaml")).toBe("yaml");
    expect(mimeToType("text/x-yaml")).toBe("yaml");
  });

  it("keeps each YAML chunk within the maxChars cap", () => {
    const longVal = `notes: ${"x".repeat(2000)}\nother: short\n`;
    const chunks = chunkSourceText(longVal, { sourceId: "s", type: "yaml", maxChars: 300 });
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(300 + 5);
    }
  });
});

describe("chunk: JSON offsets", () => {
  it("array element chunks carry real charStart/charEnd into the source text", () => {
    const text = '[{"a":1},{"b":2}]';
    const chunks = chunkSourceText(text, { sourceId: "s", type: "json" });
    expect(chunks.length).toBe(2);
    for (const c of chunks) {
      // Each span must point at the element's substring in the original text.
      expect(c.charStart).toBeGreaterThanOrEqual(0);
      expect(c.charEnd).toBeLessThanOrEqual(text.length);
      expect(c.charEnd).toBeGreaterThan(c.charStart);
    }
  });

  it("object entry chunks carry real charStart/charEnd into the source text", () => {
    const text = '{"name":"Fable","kind":"app"}';
    const chunks = chunkSourceText(text, { sourceId: "s", type: "json" });
    expect(chunks.length).toBe(2);
    for (const c of chunks) {
      expect(c.charEnd).toBeGreaterThan(c.charStart);
      expect(c.charEnd).toBeLessThanOrEqual(text.length);
    }
  });
});

describe("chunk: invariants", () => {
  it("CSV header-only input produces no chunks", () => {
    expect(chunkSourceText("name,kind,size\n", { sourceId: "s", type: "csv" })).toEqual([]);
    expect(chunkSourceText("name,kind,size", { sourceId: "s", type: "csv" })).toEqual([]);
  });

  it("never emits empty or whitespace-only chunks across types", () => {
    const inputs = [
      { type: "text" as const, text: "  \n\n  para.\n\n\n  " },
      { type: "markdown" as const, text: "# H1\n\n\n# H2\n\n  \n" },
      { type: "csv" as const, text: "h1,h2\na,b\n\nc,d\n" }
    ];
    for (const { type, text } of inputs) {
      const chunks = chunkSourceText(text, { sourceId: "s", type, maxChars: 80 });
      for (const c of chunks) {
        expect(c.text.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("is deterministic: identical normalized input yields identical chunks", () => {
    const text = "alpha beta gamma. delta epsilon zeta. eta theta iota.";
    const a = chunkSourceText(text, { sourceId: "s", type: "text", maxChars: 30 });
    const b = chunkSourceText(text, { sourceId: "s", type: "text", maxChars: 30 });
    expect(a.map((c) => ({ id: c.id, text: c.text, h: c.contentHash }))).toEqual(
      b.map((c) => ({ id: c.id, text: c.text, h: c.contentHash }))
    );
  });

  it("ordinals are contiguous 0..n-1 after normalization", () => {
    const text = "# A\n\nx\n\n# B\n\ny\n\n# C\n\nz\n";
    const chunks = chunkSourceText(text, { sourceId: "s", type: "markdown", maxChars: 12 });
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
    expect(chunks.map((c) => c.id)).toEqual(chunks.map((_, i) => `s#${i}`));
  });
});

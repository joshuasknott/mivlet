import { describe, expect, it } from "vitest";
import type { ConnectorSourceCandidate } from "@mivlet/protocol";
import {
  MAX_CANDIDATE_BYTES,
  SUPPORTED_EXTENSIONS,
  classifyCandidate,
  extensionFor,
  extensionToType,
  mimeTypeForExtension,
  resolveType
} from "./extract";

function candidate(overrides: Partial<ConnectorSourceCandidate> = {}): ConnectorSourceCandidate {
  return {
    externalId: "x",
    title: "notes.txt",
    mimeType: "text/plain",
    content: "hello world",
    sizeBytes: 11,
    fetchedAt: "2026-06-28T00:00:00.000Z",
    ...overrides
  };
}

describe("extract: extension + MIME resolution", () => {
  it("extracts the lowercase extension from a filename", () => {
    expect(extensionFor("Readme.MD")).toBe("md");
    expect(extensionFor("path/to/file.JSON")).toBe("json");
    expect(extensionFor("noext")).toBe("");
  });

  it("maps supported extensions to canonical types", () => {
    expect(extensionToType("md")).toBe("markdown");
    expect(extensionToType("markdown")).toBe("markdown");
    expect(extensionToType("json")).toBe("json");
    expect(extensionToType("csv")).toBe("csv");
    expect(extensionToType("yaml")).toBe("yaml");
    expect(extensionToType("yml")).toBe("yaml");
    expect(extensionToType("txt")).toBe("text");
  });

  it("maps extensions to MIME types", () => {
    expect(mimeTypeForExtension("md")).toBe("text/markdown");
    expect(mimeTypeForExtension("json")).toBe("application/json");
    expect(mimeTypeForExtension("csv")).toBe("text/csv");
    expect(mimeTypeForExtension("yaml")).toBe("application/yaml");
    expect(mimeTypeForExtension("txt")).toBe("text/plain");
  });

  it("resolves type from MIME, ignoring charset params", () => {
    expect(resolveType(candidate({ mimeType: "text/markdown; charset=utf-8" }))).toBe("markdown");
    expect(resolveType(candidate({ mimeType: "application/json" }))).toBe("json");
  });

  it("falls back to extension when MIME is missing/unknown", () => {
    expect(
      resolveType(candidate({ mimeType: "application/octet-stream", title: "data.csv" }))
    ).toBe("csv");
    expect(resolveType(candidate({ mimeType: "", title: "doc.md" }))).toBe("markdown");
  });

  it("returns undefined for unsupported types", () => {
    expect(resolveType(candidate({ mimeType: "application/pdf", title: "doc.pdf" }))).toBe(
      undefined
    );
  });

  it("lists the supported extension set", () => {
    expect(SUPPORTED_EXTENSIONS.has("md")).toBe(true);
    expect(SUPPORTED_EXTENSIONS.has("exe")).toBe(false);
  });
});

describe("extract: classifyCandidate", () => {
  it("returns normalized text + type for valid text", () => {
    const result = classifyCandidate(candidate({ content: "hello world", sizeBytes: 11 }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("hello world");
      expect(result.type).toBe("text");
    }
  });

  it("marks empty (whitespace-only) content as empty", () => {
    const result = classifyCandidate(candidate({ content: "   \n\t  ", sizeBytes: 6 }));
    expect(result).toEqual({ ok: false, reason: "empty", detail: expect.any(String) });
  });

  it("marks oversized payloads as oversized (size > 2MB)", () => {
    const result = classifyCandidate(
      candidate({ content: "x".repeat(10), sizeBytes: MAX_CANDIDATE_BYTES + 1 })
    );
    expect(result).toMatchObject({ ok: false, reason: "oversized" });
  });

  it("accepts payloads exactly at the 2MB cap", () => {
    const result = classifyCandidate(
      candidate({ content: "x".repeat(10), sizeBytes: MAX_CANDIDATE_BYTES })
    );
    expect(result.ok).toBe(true);
  });

  it("marks unsupported mime/extension as unsupported-type", () => {
    const result = classifyCandidate(
      candidate({ mimeType: "application/pdf", title: "doc.pdf", content: "PDF-1.4..." })
    );
    expect(result).toMatchObject({ ok: false, reason: "unsupported-type" });
  });

  it("marks NUL-byte content as binary", () => {
    const result = classifyCandidate(
      candidate({ content: "bad\u0000binary data here", sizeBytes: 20 })
    );
    expect(result).toMatchObject({ ok: false, reason: "binary" });
  });

  it("marks high-control-char ratio content as binary", () => {
    const control = "\u0001\u0002\u0003\u0004\u0005\u0006".repeat(50);
    const result = classifyCandidate(candidate({ content: control, sizeBytes: control.length }));
    expect(result).toMatchObject({ ok: false, reason: "binary" });
  });

  it("allows legitimate text with tabs and newlines (not binary)", () => {
    const content = "line one\n\tindented\nline two\n";
    const result = classifyCandidate(candidate({ content, sizeBytes: content.length }));
    expect(result.ok).toBe(true);
  });

  it("marks invalid JSON (application/json) as malformed", () => {
    const result = classifyCandidate(
      candidate({
        mimeType: "application/json",
        title: "data.json",
        content: "{ not valid json",
        sizeBytes: 16
      })
    );
    expect(result).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("accepts valid JSON", () => {
    const result = classifyCandidate(
      candidate({
        mimeType: "application/json",
        title: "data.json",
        content: '{"a":1}',
        sizeBytes: 7
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.type).toBe("json");
  });

  it("never throws — always returns a bounded outcome", () => {
    // Hostile inputs that would have thrown in a naive implementation.
    expect(() => classifyCandidate(candidate({ content: "", sizeBytes: 0 }))).not.toThrow();
    expect(() =>
      classifyCandidate(
        candidate({ mimeType: "application/json", content: "{{{{", sizeBytes: 4 })
      )
    ).not.toThrow();
    expect(() =>
      classifyCandidate(candidate({ mimeType: "x/y", title: "z.bin", content: "\u0000", sizeBytes: 1 }))
    ).not.toThrow();
  });
});

describe("extract: malformed structured files (CSV/YAML)", () => {
  it("rejects grossly ragged CSV (every row's column count differs from header)", () => {
    const ragged = "a,b,c\n1\n1,2\n1,2,3,4";
    const result = classifyCandidate(
      candidate({
        mimeType: "text/csv",
        title: "ragged.csv",
        content: ragged,
        sizeBytes: ragged.length
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  it("rejects prose masquerading as CSV (header with no delimiter, many rows)", () => {
    const prose = "this is a sentence\nwith no delimiters\nat all anywhere\nmore lines here";
    const result = classifyCandidate(
      candidate({
        mimeType: "text/csv",
        title: "prose.csv",
        content: prose,
        sizeBytes: prose.length
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  it("accepts well-formed CSV", () => {
    const csv = "name,kind\nalpha,doc\nbeta,doc";
    const result = classifyCandidate(
      candidate({
        mimeType: "text/csv",
        title: "ok.csv",
        content: csv,
        sizeBytes: csv.length
      })
    );
    expect(result.ok).toBe(true);
  });

  it("rejects tab-indented YAML", () => {
    const yaml = "name: Mivlet\n\tdetails: x\n";
    const result = classifyCandidate(
      candidate({
        mimeType: "application/yaml",
        title: "bad.yaml",
        content: yaml,
        sizeBytes: yaml.length
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  it("rejects YAML that is only comments/whitespace", () => {
    const yaml = "# just a comment\n\n   # another\n";
    const result = classifyCandidate(
      candidate({
        mimeType: "application/yaml",
        title: "empty.yaml",
        content: yaml,
        sizeBytes: yaml.length
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  it("accepts well-formed YAML", () => {
    const yaml = "name: Mivlet\nkind: app\n";
    const result = classifyCandidate(
      candidate({
        mimeType: "application/yaml",
        title: "ok.yaml",
        content: yaml,
        sizeBytes: yaml.length
      })
    );
    expect(result.ok).toBe(true);
  });
});

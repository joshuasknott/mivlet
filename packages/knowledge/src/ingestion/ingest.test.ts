import { describe, expect, it } from "vitest";
import type { ConnectorSourceCandidate, KnowledgeSource } from "@fable/protocol";
import {
  ingestCandidate,
  ingestFolder,
  localFilesCandidate,
  reindexIndex,
  sourceIdFor,
  DEFAULT_FOLDER_MAX_FILES
} from "./ingest";
import { contentHash, fnv1a64, normalizeText } from "./hash";

function candidate(overrides: Partial<ConnectorSourceCandidate> = {}): ConnectorSourceCandidate {
  return {
    externalId: "x",
    title: "notes.md",
    mimeType: "text/markdown",
    content: "# Notes\n\nSome content here.",
    sizeBytes: 26,
    fetchedAt: "2026-06-28T00:00:00.000Z",
    ...overrides
  };
}

describe("hash stability", () => {
  it("same normalized text -> same contentHash", () => {
    expect(contentHash("hello world")).toBe(contentHash("hello world"));
  });

  it("whitespace-equivalent text hashes identically", () => {
    const a = "first line\nsecond line";
    const b = "first   line\n\nsecond   line";
    const c = "  first line second line  ";
    expect(contentHash(a)).toBe(contentHash(b));
    expect(contentHash(a)).toBe(contentHash(c));
  });

  it("CRLF and LF normalize to the same hash", () => {
    expect(contentHash("line one\r\nline two")).toBe(contentHash("line one\nline two"));
  });

  it("different content -> different hash", () => {
    expect(contentHash("alpha")).not.toBe(contentHash("beta"));
  });

  it("fnv1a64 returns 16-char hex", () => {
    expect(fnv1a64("abc")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("normalizeText collapses whitespace runs", () => {
    expect(normalizeText("a\t b\n\n c")).toBe("a b c");
  });
});

describe("ingestCandidate: created", () => {
  it("returns created with a stable id and chunks", () => {
    const outcome = ingestCandidate(candidate(), { connectorId: "local-files" });
    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created") return;
    expect(outcome.source.kind).toBe("document");
    expect(outcome.source.connectorId).toBe("local-files");
    expect(outcome.source.origin).toBe("local-import");
    expect(outcome.source.trust).toBe("untrusted");
    expect(outcome.source.status).toBe("ok");
    expect(outcome.source.embeddingReady).toBe(false);
    expect(outcome.source.authority).toBe(0.5);
    expect(outcome.source.contentFingerprint).toBeTruthy();
    expect(outcome.chunks.length).toBeGreaterThan(0);
    // chunk ids are stable `${sourceId}#${ordinal}`
    expect(outcome.chunks[0].id).toBe(`${outcome.source.id}#0`);
  });

  it("re-importing identical content yields the same id (dedup)", () => {
    const a = ingestCandidate(candidate(), { connectorId: "local-files" });
    const b = ingestCandidate(candidate({ title: "renamed.md" }), { connectorId: "local-files" });
    if (a.kind !== "created" || b.kind !== "created") throw new Error("expected created");
    expect(b.source.id).toBe(a.source.id);
  });

  it("sets connector-import origin + authority for non-local connectors", () => {
    const outcome = ingestCandidate(candidate(), { connectorId: "github" });
    if (outcome.kind !== "created") throw new Error("expected created");
    expect(outcome.source.origin).toBe("connector-import");
    expect(outcome.source.authority).toBe(0.7);
    expect(outcome.source.provenance).toBe("Connector: github");
  });
});

describe("ingestCandidate: unchanged", () => {
  it("returns unchanged when existing fingerprint matches", () => {
    const fp = contentHash(candidate().content);
    const existing: KnowledgeSource = {
      id: sourceIdFor("local-files", fp),
      title: "old-name.md",
      kind: "document",
      connectorId: "local-files",
      provenance: "Local file - 26 B",
      freshness: "Imported now",
      pinned: false,
      contentFingerprint: fp
    };
    const outcome = ingestCandidate(candidate(), { connectorId: "local-files", existing });
    expect(outcome.kind).toBe("unchanged");
    if (outcome.kind === "unchanged") {
      expect(outcome.source.id).toBe(existing.id);
    }
  });
});

describe("ingestCandidate: updated", () => {
  it("returns updated with previousFingerprint when content changed", () => {
    const oldFp = contentHash("# Old\n\nold body");
    const existing: KnowledgeSource = {
      id: sourceIdFor("local-files", oldFp),
      title: "notes.md",
      kind: "document",
      connectorId: "local-files",
      provenance: "Local file",
      freshness: "Imported now",
      pinned: false,
      contentFingerprint: oldFp
    };
    const outcome = ingestCandidate(
      candidate({ content: "# New\n\nfresh body" }),
      { connectorId: "local-files", existing }
    );
    expect(outcome.kind).toBe("updated");
    if (outcome.kind === "updated") {
      expect(outcome.previousFingerprint).toBe(oldFp);
      expect(outcome.source.contentFingerprint).not.toBe(oldFp);
      expect(outcome.chunks.length).toBeGreaterThan(0);
    }
  });
});

describe("ingestCandidate: skip reasons (bounded, never throws)", () => {
  it("empty -> skipped(empty)", () => {
    const outcome = ingestCandidate(candidate({ content: "   \n  ", sizeBytes: 4 }), {
      connectorId: "local-files"
    });
    expect(outcome).toMatchObject({ kind: "skipped", reason: "empty" });
  });

  it("oversized -> skipped(oversized)", () => {
    const outcome = ingestCandidate(
      candidate({ content: "x".repeat(10), sizeBytes: 2 * 1024 * 1024 + 1 }),
      { connectorId: "local-files" }
    );
    expect(outcome).toMatchObject({ kind: "skipped", reason: "oversized" });
  });

  it("unsupported-type -> skipped(unsupported-type)", () => {
    const outcome = ingestCandidate(
      candidate({ mimeType: "application/pdf", title: "doc.pdf", content: "PDF..." }),
      { connectorId: "local-files" }
    );
    expect(outcome).toMatchObject({ kind: "skipped", reason: "unsupported-type" });
  });

  it("binary -> skipped(binary)", () => {
    const outcome = ingestCandidate(
      candidate({ content: "data\u0000binary", sizeBytes: 11 }),
      { connectorId: "local-files" }
    );
    expect(outcome).toMatchObject({ kind: "skipped", reason: "binary" });
  });

  it("malformed JSON -> skipped(malformed)", () => {
    const outcome = ingestCandidate(
      candidate({ mimeType: "application/json", title: "x.json", content: "{ bad" }),
      { connectorId: "local-files" }
    );
    expect(outcome).toMatchObject({ kind: "skipped", reason: "malformed" });
  });

  it("never throws for any hostile input", () => {
    expect(() =>
      ingestCandidate(candidate({ content: "", sizeBytes: 0 }), { connectorId: "local-files" })
    ).not.toThrow();
    expect(() =>
      ingestCandidate(candidate({ mimeType: "x/y", content: "\u0000", sizeBytes: 1 }), {
        connectorId: "local-files"
      })
    ).not.toThrow();
  });
});

describe("reindexIndex", () => {
  it("move/rename: same content, different title -> unchanged, id preserved", () => {
    const fp = contentHash("# Plan\n\nship it");
    const existing: KnowledgeSource = {
      id: sourceIdFor("local-files", fp),
      title: "old-name.md",
      kind: "document",
      connectorId: "local-files",
      provenance: "Local file",
      freshness: "Imported now",
      pinned: false,
      contentFingerprint: fp
    };
    const result = reindexIndex(
      [existing],
      [candidate({ title: "new-name.md", content: "# Plan\n\nship it" })],
      "local-files"
    );
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].kind).toBe("unchanged");
    expect(result.removedSourceIds).toEqual([]);
    if (result.outcomes[0].kind === "unchanged") {
      expect(result.outcomes[0].source.id).toBe(existing.id);
    }
  });

  it("genuinely new content -> created", () => {
    const result = reindexIndex([], [candidate({ content: "# Brand new doc" })], "local-files");
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].kind).toBe("created");
  });

  it("vanished source -> removedSourceIds", () => {
    const existing: KnowledgeSource = {
      id: "source-local-files-deadbeef",
      title: "gone.md",
      kind: "document",
      connectorId: "local-files",
      provenance: "Local file",
      freshness: "Imported now",
      pinned: false,
      contentFingerprint: "deadbeef"
    };
    const result = reindexIndex([existing], [], "local-files");
    expect(result.outcomes).toEqual([]);
    expect(result.removedSourceIds).toEqual([existing.id]);
  });

  it("updated content keeps the source but reports updated", () => {
    const oldFp = contentHash("# Old");
    const existing: KnowledgeSource = {
      id: sourceIdFor("local-files", oldFp),
      title: "doc.md",
      kind: "document",
      connectorId: "local-files",
      provenance: "Local file",
      freshness: "Imported now",
      pinned: false,
      contentFingerprint: oldFp
    };
    // Same file (doc.md), changed content -> an update of the existing source,
    // preserving its id and carrying the previous fingerprint.
    const result = reindexIndex(
      [existing],
      [candidate({ title: "doc.md", content: "# Freshly updated" })],
      "local-files"
    );
    expect(result.outcomes[0].kind).toBe("updated");
    expect(result.removedSourceIds).toEqual([]);
    if (result.outcomes[0].kind === "updated") {
      expect(result.outcomes[0].source.id).toBe(existing.id);
      expect(result.outcomes[0].previousFingerprint).toBe(oldFp);
    }
  });

  it("different path AND different content -> created (not an update)", () => {
    const oldFp = contentHash("# Old");
    const existing: KnowledgeSource = {
      id: sourceIdFor("local-files", oldFp),
      title: "doc.md",
      kind: "document",
      connectorId: "local-files",
      provenance: "Local file",
      freshness: "Imported now",
      pinned: false,
      contentFingerprint: oldFp
    };
    const result = reindexIndex(
      [existing],
      [candidate({ title: "other.md", content: "# Brand different" })],
      "local-files"
    );
    expect(result.outcomes[0].kind).toBe("created");
    // The unmatched existing source surfaces for deletion.
    expect(result.removedSourceIds).toEqual([existing.id]);
  });

  it("does NOT remove sources from a different connector", () => {
    const other: KnowledgeSource = {
      id: "source-github-abc",
      title: "remote.md",
      kind: "document",
      connectorId: "github",
      provenance: "Connector",
      freshness: "Imported now",
      pinned: false,
      contentFingerprint: "abc"
    };
    const result = reindexIndex([other], [], "local-files");
    expect(result.removedSourceIds).toEqual([]);
  });

  it("handles a comprehensive resync cycle (created, updated, unchanged, and deleted)", () => {
    const fpUnchanged = contentHash("unchanged doc content");
    const fpToUpdate = contentHash("old content that will change");
    const fpToMove = contentHash("content that will move to new file");

    const existing = [
      { id: "s-unchanged", title: "unchanged.md", kind: "document" as const, connectorId: "local-files", provenance: "Local file", freshness: "Imported now", pinned: false, contentFingerprint: fpUnchanged },
      { id: "s-update", title: "update.md", kind: "document" as const, connectorId: "local-files", provenance: "Local file", freshness: "Imported now", pinned: false, contentFingerprint: fpToUpdate },
      { id: "s-move", title: "old-path.md", kind: "document" as const, connectorId: "local-files", provenance: "Local file", freshness: "Imported now", pinned: false, contentFingerprint: fpToMove },
      { id: "s-delete", title: "deleted.md", kind: "document" as const, connectorId: "local-files", provenance: "Local file", freshness: "Imported now", pinned: false, contentFingerprint: contentHash("delete me") }
    ];

    const candidates = [
      candidate({ title: "unchanged.md", content: "unchanged doc content" }),
      candidate({ title: "update.md", content: "fresh new content after update" }),
      candidate({ title: "new-path.md", content: "content that will move to new file" }),
      candidate({ title: "brand-new.md", content: "brand new doc content" })
    ];

    const result = reindexIndex(existing, candidates, "local-files");
    expect(result.outcomes).toHaveLength(4);

    // 1. unchanged
    expect(result.outcomes[0].kind).toBe("unchanged");
    expect(result.outcomes[0].source.id).toBe("s-unchanged");

    // 2. updated
    expect(result.outcomes[1].kind).toBe("updated");
    expect(result.outcomes[1].source.id).toBe("s-update");
    if (result.outcomes[1].kind === "updated") {
      expect(result.outcomes[1].previousFingerprint).toBe(fpToUpdate);
    }

    // 3. moved (matches by content hash, so it's unchanged with title changed)
    expect(result.outcomes[2].kind).toBe("unchanged");
    expect(result.outcomes[2].source.id).toBe("s-move");

    // 4. created
    expect(result.outcomes[3].kind).toBe("created");

    // 5. deleted/vanished
    expect(result.removedSourceIds).toContain("s-delete");
    expect(result.removedSourceIds).not.toContain("s-unchanged");
    expect(result.removedSourceIds).not.toContain("s-update");
    expect(result.removedSourceIds).not.toContain("s-move");
  });
});

describe("ingestFolder", () => {
  it("respects the maxFiles cap (overflow -> too-many-files)", () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      name: `f${i}.txt`,
      content: `content ${i}`,
      sizeBytes: 10
    }));
    const outcomes = ingestFolder(files, { connectorId: "local-files", maxFiles: 3 });
    expect(outcomes).toHaveLength(5);
    const skipped = outcomes.filter((o) => o.kind === "skipped");
    expect(skipped).toHaveLength(2);
    expect(skipped.every((o) => o.kind === "skipped" && o.reason === "too-many-files")).toBe(true);
  });

  it("dedups within folder by content hash (identical content -> same id)", () => {
    const outcomes = ingestFolder(
      [
        { name: "a.txt", content: "same body", sizeBytes: 9 },
        { name: "b.txt", content: "same body", sizeBytes: 9 }
      ],
      { connectorId: "local-files" }
    );
    const created = outcomes.filter((o) => o.kind === "created");
    expect(created).toHaveLength(2);
    if (created[0].kind === "created" && created[1].kind === "created") {
      expect(created[0].source.id).toBe(created[1].source.id);
    }
  });

  it("handles folders with partial failures by skipping bad files and ingesting good ones", () => {
    const files = [
      { name: "good.txt", content: "valid body text", sizeBytes: 15 },
      { name: "empty.txt", content: "   ", sizeBytes: 3 }, // empty content -> skipped
      { name: "bad.bin", content: "binary\u0000data", sizeBytes: 11 } // binary -> skipped
    ];
    const outcomes = ingestFolder(files, { connectorId: "local-files" });
    expect(outcomes).toHaveLength(3);
    expect(outcomes[0].kind).toBe("created");
    expect(outcomes[1]).toMatchObject({ kind: "skipped", reason: "empty" });
    expect(outcomes[2]).toMatchObject({ kind: "skipped", reason: "binary" });
  });

  it("default maxFiles is 500", () => {
    expect(DEFAULT_FOLDER_MAX_FILES).toBe(500);
  });

  it("wraps each file via localFilesCandidate (mime from extension)", () => {
    const wrapped = localFilesCandidate({ name: "data.json", content: "{}", sizeBytes: 2 });
    expect(wrapped.mimeType).toBe("application/json");
    expect(wrapped.title).toBe("data.json");
  });

  it("localFilesCandidate infers markdown/yaml/csv/plain mimes", () => {
    expect(localFilesCandidate({ name: "a.md", content: "x", sizeBytes: 1 }).mimeType).toBe(
      "text/markdown"
    );
    expect(localFilesCandidate({ name: "a.csv", content: "x", sizeBytes: 1 }).mimeType).toBe(
      "text/csv"
    );
    expect(localFilesCandidate({ name: "a.yaml", content: "x", sizeBytes: 1 }).mimeType).toBe(
      "application/yaml"
    );
    expect(localFilesCandidate({ name: "a.txt", content: "x", sizeBytes: 1 }).mimeType).toBe(
      "text/plain"
    );
  });
});

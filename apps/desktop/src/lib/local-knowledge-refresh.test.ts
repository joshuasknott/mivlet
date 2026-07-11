import { describe, expect, it, vi } from "vitest";
import { importLocalTextFile } from "@fable/connectors";
import { applyLocalKnowledgeRefresh, buildLocalKnowledgeRefreshRequest } from "./local-knowledge-refresh";

const selectedAt = "2026-07-11T12:00:00.000Z";
const original = importLocalTextFile({
  name: "notes.md", content: "old notes", sizeBytes: 9, importedAt: "before"
});

function request(content = "new searchable notes") {
  return {
    sourceId: original.id,
    expectedContentFingerprint: original.contentFingerprint,
    file: { name: "notes.md", content, sizeBytes: new TextEncoder().encode(content).byteLength, selectedAt }
  };
}

describe("local knowledge refresh", () => {
  it("builds a content-only request without retaining a path or handle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(selectedAt));
    const file = { name: "notes.md", size: 3, lastModified: 1_700_000_000_000, text: async () => "new" } as File;
    const built = await buildLocalKnowledgeRefreshRequest(original, file);
    expect(built).toEqual({
      sourceId: original.id,
      expectedContentFingerprint: original.contentFingerprint,
      file: { name: "notes.md", content: "new", sizeBytes: 3, selectedAt, modifiedAt: new Date(file.lastModified).toISOString() }
    });
    expect(JSON.stringify(built)).not.toMatch(/path|handle/i);
    vi.useRealTimers();
  });

  it("preserves identity and controls while replacing searchable content", () => {
    const source = { ...original, pinned: false, disabled: true, scope: { level: "project" as const, projectId: "p1" } };
    const result = applyLocalKnowledgeRefresh(source, request());
    expect(result.outcome).toBe("updated");
    expect(result.source).toMatchObject({
      id: source.id, pinned: false, disabled: true, scope: source.scope,
      contentPreview: "new searchable notes", freshness: "Refreshed now", status: "ok"
    });
    expect(result.source.contentFingerprint).not.toBe(source.contentFingerprint);
  });

  it("returns the canonical source unchanged for identical content", () => {
    const result = applyLocalKnowledgeRefresh(original, request("old notes"));
    expect(result).toEqual({ outcome: "unchanged", source: original });
  });

  it.each([
    [{ ...request(), expectedContentFingerprint: "stale" }, /changed elsewhere/],
    [{ ...request(), file: { ...request().file, name: "other.md" } }, /current version of notes.md/],
    [{ ...request(), file: { ...request().file, sizeBytes: 999 } }, /changed while/],
    [{ ...request(), file: { ...request().file, name: "notes.exe" } }, /current version of notes.md/],
    [{ ...request(), file: { ...request().file, name: "notes.json", content: "{" } }, /current version of notes.md/]
  ])("rejects invalid requests", (invalid, message) => {
    expect(() => applyLocalKnowledgeRefresh(original, invalid)).toThrow(message);
  });

  it("rejects tombstones and malformed JSON before changing the source", () => {
    expect(() => applyLocalKnowledgeRefresh({ ...original, deletedAt: "then" }, request())).toThrow("Deleted");
    const json = importLocalTextFile({ name: "data.json", content: "{}", sizeBytes: 2, importedAt: "before" });
    expect(() => applyLocalKnowledgeRefresh(json, {
      sourceId: json.id, expectedContentFingerprint: json.contentFingerprint,
      file: { name: "data.json", content: "{", sizeBytes: 1, selectedAt }
    })).toThrow("malformed");
  });
});

import { describe, expect, it } from "vitest";
import {
  importLocalTextFile,
  localFileFingerprint,
  validateLocalFileCandidate,
  MAX_LOCAL_FILE_BYTES
} from "./local-files";

describe("local files connector", () => {
  it("imports supported text as pinned untrusted knowledge", () => {
    const content = "# Launch plan\n\nShip the workspace.";
    const imported = importLocalTextFile({
      name: "launch-plan.md",
      content,
      sizeBytes: new TextEncoder().encode(content).byteLength,
      importedAt: "2026-06-25T22:00:00.000Z"
    });

    expect(imported).toMatchObject({
      title: "launch-plan.md",
      connectorId: "local-files",
      trust: "untrusted",
      origin: "local-import",
      pinned: true,
      importedAt: "2026-06-25T22:00:00.000Z"
    });
    expect(imported.contentPreview).toContain("Ship the workspace");
    expect(imported.contentFingerprint).toBe(localFileFingerprint(content));
  });

  it("strips path components from the user-visible source name", () => {
    const content = "Workspace notes";
    const imported = importLocalTextFile({
      name: "C:\\private\\workspace-notes.txt",
      content,
      sizeBytes: content.length
    });

    expect(imported.title).toBe("workspace-notes.txt");
    expect(imported.provenance).not.toContain("private");
  });

  it("rejects unsupported extensions", () => {
    expect(() =>
      importLocalTextFile({
        name: "installer.exe",
        content: "not executable data",
        sizeBytes: 19
      })
    ).toThrow("supports text");
  });

  it("rejects files larger than two megabytes", () => {
    const content = "x".repeat(MAX_LOCAL_FILE_BYTES + 1);

    expect(() =>
      importLocalTextFile({
        name: "large.txt",
        content,
        sizeBytes: content.length
      })
    ).toThrow("smaller than 2 MB");
  });

  it("rejects payloads that change during read", () => {
    expect(() =>
      importLocalTextFile({
        name: "notes.txt",
        content: "notes",
        sizeBytes: 4
      })
    ).toThrow("changed while Fable was reading it");
  });
});

describe("local files connector: binary + malformed rejection", () => {
  it("rejects binary content (NUL byte) under a supported extension", () => {
    const content = "binary\u0000data text";
    expect(() =>
      importLocalTextFile({
        name: "data.txt",
        content,
        sizeBytes: new TextEncoder().encode(content).byteLength
      })
    ).toThrow("binary");
  });

  it("rejects malformed JSON", () => {
    expect(() =>
      importLocalTextFile({
        name: "broken.json",
        content: "{{{{not json",
        sizeBytes: 12
      })
    ).toThrow("malformed");
  });

  it("validateLocalFileCandidate returns a bounded result for binary", () => {
    const content = "x\u0000y";
    const result = validateLocalFileCandidate({
      name: "data.txt",
      content,
      sizeBytes: new TextEncoder().encode(content).byteLength
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("binary");
  });

  it("validateLocalFileCandidate returns mediaType on success", () => {
    const result = validateLocalFileCandidate({
      name: "notes.md",
      content: "# Hi",
      sizeBytes: 4
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mediaType).toBe("text/markdown");
  });
});

describe("local files connector: metadata preservation", () => {
  it("preserves sourcePath, mediaType, and modifiedAt on the import", () => {
    const content = "# Notes";
    const imported = importLocalTextFile({
      name: "docs/notes.md",
      content,
      sizeBytes: new TextEncoder().encode(content).byteLength,
      sourcePath: "docs/notes.md",
      modifiedAt: "2026-06-01T00:00:00.000Z"
    });
    expect(imported.sourcePath).toBe("docs/notes.md");
    expect(imported.mediaType).toBe("text/markdown");
    expect(imported.modifiedAt).toBe("2026-06-01T00:00:00.000Z");
  });
});

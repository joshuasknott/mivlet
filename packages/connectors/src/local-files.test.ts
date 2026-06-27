import { describe, expect, it } from "vitest";
import {
  importLocalTextFile,
  localFileFingerprint,
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

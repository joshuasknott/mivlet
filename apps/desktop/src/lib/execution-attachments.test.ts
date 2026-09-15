import { describe, expect, it } from "vitest";
import type { CollaborationWorkItem, WorkAttachment } from "@mivlet/protocol";
import type { ComposerAttachment } from "./types";
import {
  missingRestagedPaths,
  resolveWorkAttachments,
  restagedAttachmentRefs,
} from "./execution-attachments";
import {
  composerAttachmentRefs,
  stagedAttachmentRefs,
} from "./workspace-execution";

const work = (attachments: CollaborationWorkItem["attachments"] = []): CollaborationWorkItem =>
  ({
    attachments,
    createdAt: "2026-09-12T10:00:00Z",
  }) as CollaborationWorkItem;

describe("work attachment recovery", () => {
  it("records composer refs at submission without claiming staged paths", () => {
    const attachments: ComposerAttachment[] = [
      {
        id: "upload",
        name: "brief.txt",
        type: "text/plain",
        sizeBytes: 128,
        transientBytes: new Uint8Array([1, 2, 3]),
      },
      {
        id: "photo",
        name: "photo.png",
        type: "image/png",
        sizeBytes: 2048,
        imageInput: { dataUrl: "data:image/png;base64,AA==", mimeType: "image/png" } as never,
      },
      {
        id: "catalog",
        name: "catalog.pdf",
        type: "application/pdf",
        sizeBytes: 4096,
        sourceId: "knowledge-1",
      },
      {
        id: "repo",
        name: "repo.zip",
        type: "application/zip",
        sizeBytes: 999,
        workspaceFile: {
          attachmentId: "repo",
          originalName: "repo.zip",
          mimeType: "application/zip",
          relativePath: "Attachments/batch-0/repo.zip",
          sizeBytes: 999,
          computerId: "c",
          batchId: "b",
          sha256: "s",
          stagedAt: "2026-09-12T09:00:00Z",
        },
      },
    ];
    expect(composerAttachmentRefs(attachments)).toEqual([
      { id: "upload", name: "brief.txt", mimeType: "text/plain", sizeBytes: 128, availability: "transient" },
      { id: "photo", name: "photo.png", mimeType: "image/png", sizeBytes: 2048, availability: "image-input" },
      { id: "catalog", name: "catalog.pdf", mimeType: "application/pdf", sizeBytes: 4096, availability: "knowledge-context", sourceId: "knowledge-1" },
      { id: "repo", name: "repo.zip", mimeType: "application/zip", sizeBytes: 999, availability: "workspace-file", relativePath: "Attachments/batch-0/repo.zip", sha256: "s" },
    ]);
  });

  it("refreshes staged refs at bind with the durable workspace path and hash", () => {
    const staged: ComposerAttachment[] = [
      {
        id: "upload",
        name: "brief.txt",
        type: "text/plain",
        sizeBytes: 128,
        workspaceFile: {
          attachmentId: "upload",
          originalName: "brief.txt",
          mimeType: "text/plain",
          relativePath: "Attachments/batch-1/brief.txt",
          sizeBytes: 128,
          computerId: "c",
          batchId: "b",
          sha256: "s",
          stagedAt: "2026-09-12T10:05:00Z",
        },
        status: "Workspace/Attachments/batch-1/brief.txt",
      },
      {
        id: "catalog",
        name: "catalog.pdf",
        type: "application/pdf",
        sizeBytes: 4096,
        sourceId: "knowledge-1",
      },
    ];
    expect(stagedAttachmentRefs(staged)).toEqual([
      { id: "upload", name: "brief.txt", mimeType: "text/plain", sizeBytes: 128, availability: "workspace-file", relativePath: "Attachments/batch-1/brief.txt", sha256: "s" },
      { id: "catalog", name: "catalog.pdf", mimeType: "application/pdf", sizeBytes: 4096, availability: "knowledge-context", sourceId: "knowledge-1" },
    ]);
  });

  it("never invents a staged receipt for an unstaged transient upload", () => {
    const unstaged: ComposerAttachment[] = [
      { id: "late", name: "late.txt", type: "text/plain", sizeBytes: 3, transientBytes: new Uint8Array([1, 2, 3]) },
    ];
    expect(stagedAttachmentRefs(unstaged)).toEqual([
      { id: "late", name: "late.txt", mimeType: "text/plain", sizeBytes: 3, availability: "transient" },
    ]);
  });

  it("restages durable workspace and knowledge refs when composer inputs are gone", () => {
    const record: WorkAttachment = { id: "upload", name: "brief.txt", mimeType: "text/plain", sizeBytes: 128, availability: "workspace-file", relativePath: "Attachments/batch-1/brief.txt", sha256: "s" };
    const restored = restagedAttachmentRefs(
      work([
        record,
        { id: "catalog", name: "catalog.pdf", mimeType: "application/pdf", sizeBytes: 4096, availability: "knowledge-context", sourceId: "knowledge-1" },
      ]),
    );
    expect(restored).toHaveLength(2);
    // The restaged attachment carries the recorded reference itself; native
    // code re-verifies it instead of trusting invented receipt metadata.
    expect(restored[0].durableRef).toEqual(record);
    expect(restored[0].workspaceFile).toBeUndefined();
    expect(restored[1].sourceId).toBe("knowledge-1");
  });

  it("fails closed with the exact prerequisite for in-memory inputs", () => {
    expect(
      resolveWorkAttachments([], work([{ id: "photo", name: "photo.png", mimeType: "image/png", sizeBytes: 2, availability: "image-input" }])),
    ).toEqual({
      attachments: [],
      error: "This request included images that were only held in memory. Reattach the original images before continuing.",
    });
    expect(
      resolveWorkAttachments([], work([{ id: "upload", name: "brief.txt", mimeType: "text/plain", sizeBytes: 2, availability: "transient" }])),
    ).toEqual({
      attachments: [],
      error: "This request included files that were only held in memory. Reattach them before continuing.",
    });
  });

  it("keeps live composer inputs only when they cover every recorded reference", () => {
    const live: ComposerAttachment[] = [
      { id: "upload", name: "brief.txt", type: "text/plain", sizeBytes: 128, transientBytes: new Uint8Array([1]) },
    ];
    expect(resolveWorkAttachments(live, work([])).attachments).toEqual(live);
    expect(
      resolveWorkAttachments(live, work([
        { id: "upload", name: "brief.txt", mimeType: "text/plain", sizeBytes: 128, availability: "transient" },
      ])).attachments,
    ).toEqual(live);
    // A live attachment without the recorded bytes cannot silently cover a
    // staged file reference.
    expect(
      resolveWorkAttachments(
        [{ id: "upload", name: "brief.txt", type: "text/plain", sizeBytes: 128 }],
        work([
          { id: "upload", name: "brief.txt", mimeType: "text/plain", sizeBytes: 128, availability: "workspace-file", relativePath: "Attachments/batch-1/brief.txt", sha256: "s" },
        ]),
      ),
    ).toEqual({
      attachments: [],
      error: "This request's attached files no longer match its saved references: brief.txt. Reattach them before continuing.",
    });
    // A mismatched knowledge source id fails closed for the same reason.
    expect(
      resolveWorkAttachments(
        [{ id: "catalog", name: "catalog.pdf", type: "application/pdf", sizeBytes: 1, sourceId: "knowledge-2" }],
        work([
          { id: "catalog", name: "catalog.pdf", mimeType: "application/pdf", sizeBytes: 4096, availability: "knowledge-context", sourceId: "knowledge-1" },
        ]),
      ).error,
    ).toContain("catalog.pdf");
    const missing = missingRestagedPaths(
      [{ id: "upload", name: "brief.txt", mimeType: "text/plain", sizeBytes: 128, availability: "workspace-file", relativePath: "Attachments/batch-1/brief.txt" }],
      [{ path: "Attachments/batch-1/other.txt", name: "other.txt", kind: "file" } as { path: string }],
    );
    expect(missing.map((ref) => ref.id)).toEqual(["upload"]);
    expect(
      missingRestagedPaths(
        [{ id: "upload", name: "brief.txt", mimeType: "text/plain", sizeBytes: 128, availability: "workspace-file", relativePath: "Attachments/batch-1/brief.txt" }],
        [{ path: "Attachments/batch-1/brief.txt", name: "brief.txt", kind: "file" } as { path: string }],
      ),
    ).toEqual([]);
  });
});
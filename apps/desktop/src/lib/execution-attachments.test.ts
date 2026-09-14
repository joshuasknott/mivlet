import { describe, expect, it } from "vitest";
import type { CollaborationWorkItem } from "@fable/protocol";
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
      { id: "repo", name: "repo.zip", mimeType: "application/zip", sizeBytes: 999, availability: "workspace-file", relativePath: "Attachments/batch-0/repo.zip" },
    ]);
  });

  it("refreshes staged refs at bind with the durable workspace path", () => {
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
      { id: "upload", name: "brief.txt", mimeType: "text/plain", sizeBytes: 128, availability: "workspace-file", relativePath: "Attachments/batch-1/brief.txt" },
      { id: "catalog", name: "catalog.pdf", mimeType: "application/pdf", sizeBytes: 4096, availability: "knowledge-context", sourceId: "knowledge-1" },
    ]);
  });

  it("restages durable workspace and knowledge refs when composer inputs are gone", () => {
    const restored = restagedAttachmentRefs(
      work([
        { id: "upload", name: "brief.txt", mimeType: "text/plain", sizeBytes: 128, availability: "workspace-file", relativePath: "Attachments/batch-1/brief.txt" },
        { id: "catalog", name: "catalog.pdf", mimeType: "application/pdf", sizeBytes: 4096, availability: "knowledge-context", sourceId: "knowledge-1" },
      ]),
    );
    expect(restored).toHaveLength(2);
    expect(restored[0].workspaceFile?.relativePath).toBe("Attachments/batch-1/brief.txt");
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

  it("keeps live composer inputs and reports cleaned-up staged files", () => {
    const live: ComposerAttachment[] = [
      { id: "upload", name: "brief.txt", type: "text/plain", sizeBytes: 128, transientBytes: new Uint8Array([1]) },
    ];
    expect(resolveWorkAttachments(live, work([])).attachments).toEqual(live);
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
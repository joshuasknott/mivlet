import { describe, expect, it, vi } from "vitest";
import type { CollaborationWorkItem, LocalComputerAttachmentReceipt, WorkAttachment } from "@mivlet/protocol";
import { prepareSharedExecutionAttachments, sharedRequestAttachmentIds } from "./shared-execution-attachments";

const source: WorkAttachment = { id: "image", name: "diagram.png", mimeType: "image/png", sizeBytes: 4,
  availability: "workspace-file", relativePath: "Attachments/sender/diagram.png", sha256: "a".repeat(64) };
const root = { id: "root", workspaceId: "w", attachments: [source] } as CollaborationWorkItem;
const work = { id: "child", rootId: "root", parentId: "root", agentId: "recipient", workspaceId: "w", generation: 3,
  attachments: [{ ...source, availability: "transient", relativePath: undefined, sha256: undefined }] } as CollaborationWorkItem;
const node = { workspaceId: "w", agentId: "recipient", computerId: "recipient-computer", generation: 7 };
const receipt: LocalComputerAttachmentReceipt = { attachmentId: "image", originalName: source.name,
  mimeType: source.mimeType, sizeBytes: 4, sha256: source.sha256!, computerId: node.computerId, batchId: "recipient-batch",
  relativePath: "Attachments/recipient-batch/diagram.png", stagedAt: "2026-10-17T12:00:00Z" };

describe("canonical shared request files", () => {
  it("recovers a queued child after restart through native task identity and hydrates only the recipient copy", async () => {
    const stage = vi.fn().mockResolvedValue([receipt]);
    const result = await prepareSharedExecutionAttachments({ work, root, node, attachments: [], isCurrent: () => true }, stage);
    expect(stage).toHaveBeenCalledWith({ workspaceId: "w", agentId: "recipient", workId: "child", expectedWorkGeneration: 3,
      expectedGeneration: 7, attachmentIds: ["image"] });
    expect(result).toEqual([expect.objectContaining({ id: "image", workspaceFile: receipt,
      imageInput: undefined, transientBytes: undefined,
      durableRef: expect.objectContaining({ availability: "workspace-file", relativePath: receipt.relativePath, sha256: receipt.sha256 }) })]);
  });

  it("does not recover a different workspace, unrelated root, or changed metadata", () => {
    expect(sharedRequestAttachmentIds(work, { ...root, workspaceId: "other" })).toEqual([]);
    expect(sharedRequestAttachmentIds(work, { ...root, id: "other" })).toEqual([]);
    expect(sharedRequestAttachmentIds(work, { ...root, attachments: [{ ...source, sizeBytes: 9 }] })).toEqual([]);
    expect(sharedRequestAttachmentIds({ ...work, parentId: undefined }, root)).toEqual([]);
  });

  it("cleans an unadopted recipient batch if the Work changes after copying", async () => {
    let current = true;
    const stage = vi.fn().mockImplementation(async () => { current = false; return [receipt]; });
    const discard = vi.fn().mockResolvedValue(undefined);
    await expect(prepareSharedExecutionAttachments({ work, root, node, attachments: [], isCurrent: () => current }, stage, discard))
      .rejects.toThrow("changed");
    expect(discard).toHaveBeenCalledWith({ workspaceId: "w", agentId: "recipient", computerId: node.computerId, batchId: receipt.batchId });
  });

  it("rejects altered copied bytes and never discards a sender's batch", async () => {
    const discard = vi.fn().mockResolvedValue(undefined);
    const altered = vi.fn().mockResolvedValue([{ ...receipt, sha256: "b".repeat(64) }]);
    await expect(prepareSharedExecutionAttachments({ work, root, node, attachments: [], isCurrent: () => true }, altered, discard))
      .rejects.toThrow("receipts");
    expect(discard).toHaveBeenCalledTimes(1);
    discard.mockClear();
    const sender = vi.fn().mockResolvedValue([{ ...receipt, computerId: "sender-computer" }]);
    await expect(prepareSharedExecutionAttachments({ work, root, node, attachments: [], isCurrent: () => true }, sender, discard))
      .rejects.toThrow("receipts");
    expect(discard).not.toHaveBeenCalled();
  });
});

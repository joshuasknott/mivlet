import type { CollaborationWorkItem, LocalComputerAttachmentReceipt, LocalComputerSnapshot } from "@mivlet/protocol";
import { stageRuntimeWorkAttachments } from "../runtime/domains/local-computer";
import type { ComposerAttachment } from "./types";

/** Native Work, rather than a renderer-supplied source path, identifies the
 * exact input deliberately inherited by this recipient. */
export function sharedRequestAttachmentIds(work: CollaborationWorkItem, root?: CollaborationWorkItem): string[] {
  if (!work.parentId || !root || root.id !== work.rootId || root.workspaceId !== work.workspaceId) return [];
  return (work.attachments ?? []).filter(ref => ref.availability === "transient" && root.attachments?.some(source =>
    source.id === ref.id && source.availability === "workspace-file" && source.relativePath && source.sha256
      && source.mimeType === ref.mimeType && source.sizeBytes === ref.sizeBytes)).map(ref => ref.id);
}

export async function prepareSharedExecutionAttachments(input: {
  work: CollaborationWorkItem;
  root?: CollaborationWorkItem;
  attachments: readonly ComposerAttachment[];
  node: Pick<LocalComputerSnapshot, "workspaceId" | "agentId" | "computerId" | "generation"> | null;
  isCurrent: () => boolean;
}, stage = stageRuntimeWorkAttachments): Promise<ComposerAttachment[]> {
  const ids = sharedRequestAttachmentIds(input.work, input.root);
  if (!ids.length) return [...input.attachments];
  const { work, node } = input;
  if (!input.isCurrent() || !node || node.workspaceId !== work.workspaceId || node.agentId !== work.agentId)
    throw new Error("This recipient's computer is unavailable. Refresh it before preparing the shared request files.");
  const receipts = await stage({ workspaceId: work.workspaceId, agentId: work.agentId, workId: work.id,
    expectedWorkGeneration: work.generation, expectedGeneration: node.generation, attachmentIds: ids });
  if (!input.isCurrent()) throw new Error("This assignment changed while its shared inputs were prepared. No provider request was sent.");
  const byId = new Map<string, LocalComputerAttachmentReceipt>((receipts ?? []).map(receipt => [receipt.attachmentId, receipt]));
  if (!receipts || receipts.length !== ids.length || byId.size !== ids.length || ids.some(id => {
    const receipt = byId.get(id);
    const source = input.root?.attachments?.find(ref => ref.id === id);
    return !receipt || !source || receipt.computerId !== node.computerId || receipt.sha256 !== source.sha256
      || receipt.mimeType !== source.mimeType || receipt.sizeBytes !== source.sizeBytes;
  })) throw new Error("The shared file receipts did not match this recipient and the original request. Inspect its saved inputs before continuing.");
  const supplied = new Map(input.attachments.map(attachment => [attachment.id, attachment]));
  for (const id of ids) {
    const ref = work.attachments!.find(ref => ref.id === id)!;
    const receipt = byId.get(id)!;
    supplied.set(id, { ...supplied.get(id), id, name: ref.name, type: ref.mimeType, sizeBytes: ref.sizeBytes,
      // Hydration reads the exact recipient copy. Original sender pixels and
      // paths are never mistaken for the new receipt's contents or authority.
      imageInput: undefined, previewUrl: undefined, transientBytes: undefined,
      workspaceFile: receipt, durableRef: { id, name: ref.name, mimeType: ref.mimeType, sizeBytes: ref.sizeBytes,
        availability: "workspace-file", relativePath: receipt.relativePath, sha256: receipt.sha256 },
      status: `Workspace/${receipt.relativePath}` });
  }
  return [...supplied.values()];
}

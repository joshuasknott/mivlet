import type {
  CollaborationWorkItem,
  LocalComputerSnapshot,
  Spine,
  WorkAttachment,
} from "@fable/protocol";
import type { ComposerAttachment } from "./types";
import type { useLocalComputer } from "../hooks/useLocalComputer";
import {
  stageRuntimeLocalComputerAttachment,
  discardRuntimeLocalComputerAttachmentBatch,
} from "../runtime/domains/local-computer";

function encodeAttachmentBytes(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return window.btoa(binary);
}

/** Reconstructs durable attachment inputs for a continued assignment whose
 * composer inputs are gone (restart or a released prior run). Workspace refs
 * point at the staged files under the account root; knowledge refs resolve by
 * source identity. In-memory refs (images, unbound transient uploads) cannot
 * be restored and must fail closed before dispatch. */
export function restagedAttachmentRefs(
  work: Pick<CollaborationWorkItem, "attachments" | "createdAt">,
): ComposerAttachment[] {
  return (work.attachments ?? []).flatMap<ComposerAttachment>((ref) => {
    if (ref.availability === "workspace-file" && ref.relativePath)
      return [
        {
          id: ref.id,
          name: ref.name,
          type: ref.mimeType,
          sizeBytes: ref.sizeBytes,
          workspaceFile: {
            attachmentId: ref.id,
            originalName: ref.name,
            mimeType: ref.mimeType,
            relativePath: ref.relativePath,
            sizeBytes: ref.sizeBytes,
            // Durable refs predate any new staging batch; nothing discards them.
            computerId: "",
            batchId: "",
            sha256: "",
            stagedAt: work.createdAt,
          },
          status: `Workspace/${ref.relativePath}`,
        },
      ];
    if (ref.availability === "knowledge-context" && ref.sourceId)
      return [
        {
          id: ref.id,
          name: ref.name,
          type: ref.mimeType,
          sizeBytes: ref.sizeBytes,
          sourceId: ref.sourceId,
        },
      ];
    return [];
  });
}

/** Chooses inputs for one admission: original composer inputs when present,
 * otherwise durable refs, and fails closed with the exact missing prerequisite
 * when the request referenced inputs that only existed in memory. */
export function resolveWorkAttachments(
  sessionAttachments: readonly ComposerAttachment[],
  work: Pick<CollaborationWorkItem, "attachments" | "createdAt">,
): { attachments: ComposerAttachment[]; error?: string } {
  if (sessionAttachments.length) return { attachments: [...sessionAttachments] };
  const refs = work.attachments ?? [];
  const unrecoverable = refs.filter(
    (ref) =>
      ref.availability === "transient" || ref.availability === "image-input",
  );
  if (unrecoverable.length) {
    const image = unrecoverable.some(
      (ref) => ref.availability === "image-input",
    );
    return {
      attachments: [],
      error: image
        ? "This request included images that were only held in memory. Reattach the original images before continuing."
        : "This request included files that were only held in memory. Reattach them before continuing.",
    };
  }
  return { attachments: restagedAttachmentRefs(work) };
}

/** Restaged workspace refs must still exist under the account root. */
export function missingRestagedPaths(
  refs: readonly WorkAttachment[],
  entries: readonly { path: string }[],
): WorkAttachment[] {
  return refs.filter(
    (ref) =>
      ref.availability === "workspace-file" &&
      ref.relativePath &&
      !entries.some((entry) => entry.path === ref.relativePath),
  );
}

export function attachmentRunInstructions(
  attachments: readonly ComposerAttachment[],
) {
  if (!attachments.length) return "";
  const lines = attachments.map((attachment) => {
    if (attachment.imageInput)
      return `- ${attachment.name}: supplied directly as a transient image input; it has no workspace file path.`;
    if (attachment.workspaceFile)
      return `- ${attachment.name}: exact uploaded bytes are readable with read-file at ${JSON.stringify(attachment.workspaceFile.relativePath)}.`;
    if (attachment.sourceId)
      return `- ${attachment.name}: supplied as knowledge context only. It has no readable workspace path; do not guess one.`;
    return `- ${attachment.name}: metadata only; ask the user to reattach it before reading.`;
  });
  return `Attachments for this turn:\n${lines.join("\n")}`;
}

export function attachmentMessageMetadata(
  attachments: readonly ComposerAttachment[],
  project: boolean,
): Spine.Conversations.ConversationAttachmentMetadata[] {
  return attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    mimeType:
      attachment.workspaceFile?.mimeType ||
      attachment.type ||
      "application/octet-stream",
    sizeBytes: attachment.sizeBytes,
    availability:
      project && attachment.sourceId
        ? "project-file"
        : attachment.workspaceFile
          ? "workspace-file"
          : attachment.imageInput
            ? "image-input"
            : "knowledge-context",
    ...(!project && attachment.workspaceFile
      ? { relativePath: attachment.workspaceFile.relativePath }
      : {}),
  }));
}

export async function prepareExecutionAttachments(
  attachments: readonly ComposerAttachment[],
  localComputer: Pick<
    ReturnType<typeof useLocalComputer>,
    "refresh" | "prepareForTool" | "refreshFiles"
  >,
  workspaceId: string,
  agentId: string,
  isCurrent: () => boolean,
): Promise<{
  attachments: ComposerAttachment[];
  node: LocalComputerSnapshot | null;
  batch?: { computerId: string; batchId: string };
}> {
  const stageable = attachments.filter(
    (attachment) =>
      attachment.transientBytes && !attachment.type.startsWith("image/"),
  );
  if (!stageable.length) {
    // Headless workers mount immediately before dispatch. The hook's first
    // render may still be loading, so resolve capabilities for this execution.
    const node = await localComputer.refresh().catch(() => null);
    return {
      attachments: [...attachments],
      node:
        isCurrent() &&
        node?.workspaceId === workspaceId &&
        node.agentId === agentId
          ? node
          : null,
    };
  }
  let node;
  try {
    node = await localComputer.prepareForTool("read-file");
  } catch {
    return { attachments: [...attachments], node: null };
  }
  if (!isCurrent()) return { attachments: [...attachments], node };
  if (node.workspaceId !== workspaceId || node.agentId !== agentId) {
    return { attachments: [...attachments], node: null };
  }
  try {
    const encoded = [];
    for (const attachment of stageable) {
      if (!isCurrent()) return { attachments: [...attachments], node };
      encoded.push({
        attachmentId: attachment.id,
        name: attachment.name,
        mimeType: attachment.type,
        contentBase64: encodeAttachmentBytes(attachment.transientBytes!),
      });
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    if (!isCurrent()) return { attachments: [...attachments], node };
    const receipts = await stageRuntimeLocalComputerAttachment({
      workspaceId,
      agentId,
      expectedGeneration: node.generation,
      attachments: encoded,
    });
    const byId = new Map(
      receipts?.map((receipt) => [receipt.attachmentId, receipt]),
    );
    const batchIds = new Set(receipts?.map((receipt) => receipt.batchId));
    if (
      !receipts ||
      receipts.length !== stageable.length ||
      byId.size !== stageable.length ||
      batchIds.size !== 1
    )
      throw new Error(
        "The staged attachment receipt did not match this upload.",
      );
    const batch = { computerId: node.computerId, batchId: receipts[0].batchId };
    if (!isCurrent()) {
      await discardRuntimeLocalComputerAttachmentBatch({
        workspaceId,
        agentId,
        ...batch,
      }).catch(() => undefined);
      return { attachments: [...attachments], node };
    }
    const staged = attachments.map((attachment) => {
      if (!attachment.transientBytes || attachment.type.startsWith("image/"))
        return attachment;
      const receipt = byId.get(attachment.id);
      if (
        !receipt ||
        receipt.computerId !== node.computerId ||
        receipt.sizeBytes !== attachment.transientBytes.byteLength
      )
        throw new Error(
          "The staged attachment receipt did not match this upload.",
        );
      return {
        ...attachment,
        workspaceFile: receipt,
        status: `Workspace/${receipt.relativePath}`,
      };
    });
    void localComputer.refreshFiles();
    return { attachments: staged, node, batch };
  } catch {
    if (!isCurrent()) return { attachments: [...attachments], node };
    return {
      attachments: attachments.map((attachment) =>
        attachment.transientBytes && !attachment.type.startsWith("image/")
          ? {
              ...attachment,
              workspaceFile: undefined,
              status: "Knowledge context only",
            }
          : attachment,
      ),
      node,
    };
  }
}

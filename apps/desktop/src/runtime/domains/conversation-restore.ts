import type {
  ConversationRestoreIntent,
  ConversationRestoreListing,
  ConversationRestoreOwner,
  ConversationRestoreReview,
} from "@mivlet/protocol";
import { invokeNative } from "../bridge";
import {
  executeCheckpointAction,
  prepareCheckpointAction,
  type CheckpointAction,
} from "./repository-checkpoints";

export async function conversationRestore<T>(
  owner: ConversationRestoreOwner,
  command: {
    action:
      | "list"
      | "preview"
      | "preview-revert"
      | "stage"
      | "finish"
      | "reconcile"
      | "cancel"
      | "forget-point"
      | "clear-completed";
    pointId?: string;
    intentId?: string;
    previewId?: string;
    approvalRequestId?: string;
    expectedHeadId?: string | null;
    expectedLastSequence?: number;
  },
): Promise<T> {
  const result = await invokeNative<T>("conversation_restore", {
    request: { ...owner, ...command },
  });
  if (!result)
    throw new Error(
      "Conversation and file recovery require the installed desktop app.",
    );
  return result;
}
export const listConversationRestorePoints = (
  owner: ConversationRestoreOwner,
) => conversationRestore<ConversationRestoreListing>(owner, { action: "list" });
export function prepareConversationRestore(
  review: ConversationRestoreReview,
): CheckpointAction {
  const { point, checkpoint } = review;
  return prepareCheckpointAction(
    {
      workspaceId: point.workspaceId,
      agentId: point.agentId,
      expectedGeneration: review.computerGeneration,
    },
    "restore",
    {
      repositoryId: point.repository.repositoryId,
      checkpointId: checkpoint.checkpoint.id,
      expectedTree: checkpoint.currentTreeId,
      expectedCheckpointTree: checkpoint.checkpoint.treeId,
      expectedOutput: checkpoint.outputTreeId,
      expectedHead: checkpoint.head,
    },
  );
}
/** Native intent is recorded before consuming the existing exact file approval.
 * A failure is uncertain and is reconciled explicitly; never retry this method
 * automatically after a timeout, account transition or process interruption. */
export async function executeConversationRestore(
  owner: ConversationRestoreOwner,
  review: ConversationRestoreReview,
  action: CheckpointAction,
  confirmation: string,
) {
  const intent = await conversationRestore<ConversationRestoreIntent>(owner, {
    action: "stage",
    previewId: review.id,
    approvalRequestId: action.approval.id,
  });
  await executeCheckpointAction(action, confirmation);
  if (review.direction === "restore")
    return conversationRestore<ConversationRestoreIntent>(owner, {
      action: "finish",
      intentId: intent.id,
    });
  return { ...intent, state: "reverted" as const };
}

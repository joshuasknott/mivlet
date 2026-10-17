import type { CollaborationWorkItem, NativeCommandTarget } from "@mivlet/protocol";

export interface PreviewFeedbackSource extends Pick<NativeCommandTarget, "agentId" | "jobId" | "jobGeneration"> {
  runId: string;
  repositoryId: string;
}

/** Saved run provenance chooses the existing task; Library selection is irrelevant. */
export function previewFeedbackWork(work: readonly CollaborationWorkItem[], conversationId: string, source: PreviewFeedbackSource) {
  const matches = work.filter(item => item.conversationId === conversationId && item.agentId === source.agentId
    && item.runIds.includes(source.runId) && item.repositoryBinding?.repositoryId === source.repositoryId);
  if (matches.length !== 1)
    throw new Error("The preview’s original task and repository could not be matched. Reopen its saved result; your draft was kept.");
  const item = matches[0];
  if (["failed", "cancelled"].includes(item.status) || item.status === "awaiting-user" && !item.awaitingUser)
    throw new Error("Review and reconcile the preview’s original task before adding feedback. Your draft was kept.");
  if (item.turnCount >= item.maxTurns || item.tokenUsage >= item.maxTokens)
    throw new Error("The preview’s original task reached its budget. Review its continuation limits before adding feedback. Your draft was kept.");
  return item;
}

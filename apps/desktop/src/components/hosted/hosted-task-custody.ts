import { canonicalHostedTaskJson, type CollaborationSnapshot, type CollaborationWorkItem, type HostedTaskBinding, type HostedTaskControlResult, type HostedTaskReview } from "@mivlet/protocol";

export function sameHostedBinding(left: HostedTaskBinding | undefined, right: HostedTaskBinding | undefined): boolean {
  return Boolean(left && right && canonicalHostedTaskJson(left) === canonicalHostedTaskJson(right));
}
function canonicalWork(item: CollaborationWorkItem, snapshot: CollaborationSnapshot, minimum: number, preparing = false): CollaborationWorkItem {
  const matches = snapshot.work?.filter(work => work.id === item.id);
  const work = matches?.length === 1 ? matches[0] : undefined;
  if (!work || work.workspaceId !== item.workspaceId || work.agentId !== item.agentId
    || work.conversationId !== item.conversationId || work.conversationGeneration !== item.conversationGeneration
    || work.rootId !== item.rootId || work.parentId !== item.parentId
    || !Number.isSafeInteger(work.generation) || work.generation < minimum || preparing && work.generation > minimum + 1)
    throw new Error("The native task changed. Refresh its recorded cloud status.");
  return work;
}
function boundWork(work: CollaborationWorkItem, binding: HostedTaskBinding): boolean {
  return Boolean(binding.workspaceId && binding.workId === work.id && binding.agentId === work.agentId
    && binding.conversationId === work.conversationId && binding.conversationGeneration === work.conversationGeneration
    && sameHostedBinding(work.hostedTask?.binding, binding));
}
/** Native returns local canonical Work and its separate cloud capability binding.
 * Never compare a Convex workspace ID to the local hosted-<digest> directory ID. */
export function assertHostedReview(item: CollaborationWorkItem, review: HostedTaskReview, minimum = item.generation): CollaborationWorkItem {
  const work = canonicalWork(item, review.collaboration, minimum, true);
  if (review.workId !== work.id || review.workGeneration !== work.generation || review.admission.binding.workGeneration !== work.generation
    || work.status !== "queued" || !work.queue?.held || work.executionOwner || work.currentRunId
    || work.hostedTask?.phase !== "review" || work.hostedTask.reviewId !== review.reviewId
    || !boundWork(work, review.admission.binding))
    throw new Error("The cloud review does not match its native task. Refresh cloud status, then review again.");
  return work;
}
export function assertHostedControl(item: CollaborationWorkItem, result: HostedTaskControlResult, expected: HostedTaskBinding | undefined,
  minimum = item.generation, allowReleased = false): CollaborationWorkItem {
  const work = canonicalWork(item, result.collaboration, minimum);
  if (!expected || work.hostedTask && !boundWork(work, expected)
    || !work.hostedTask && (!allowReleased || work.generation <= expected.workGeneration
      || work.executionOwner || work.currentRunId || !["queued", "cancelled"].includes(work.status))
    || result.taskResult && (!work.hostedTask || !sameHostedBinding(result.taskResult.snapshot.binding, expected)))
    throw new Error("The cloud result does not match its native task binding. Refresh cloud status.");
  return work;
}

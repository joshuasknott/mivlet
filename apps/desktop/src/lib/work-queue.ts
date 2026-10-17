import type { CollaborationWorkItem } from "@mivlet/protocol";

export function compareQueuedWork(a: CollaborationWorkItem, b: CollaborationWorkItem) {
  return (a.queue?.order ?? 0) - (b.queue?.order ?? 0)
    || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

export function workCanDispatch(item: CollaborationWorkItem, all: CollaborationWorkItem[]) {
  const root = all.find(work => work.id === item.rootId) ?? item;
  if (root.executionOwner === "hosted" || root.queue?.held || (root.outcomeGoal && root.outcomeGoal.status !== "active")) return false;
  return !all.some(other => {
    if (other.id === item.id || other.rootId === item.rootId || other.agentId !== item.agentId || other.status !== "queued") return false;
    const earlier = all.find(work => work.id === other.rootId) ?? other;
    return !earlier.queue?.held && (!earlier.outcomeGoal || earlier.outcomeGoal.status === "active")
      && compareQueuedWork(earlier, root) < 0;
  });
}

export function editableQueue(work: CollaborationWorkItem[], conversationId: string) {
  return work.filter(item => item.conversationId === conversationId && !item.parentId && item.status === "queued"
    && item.executionOwner !== "hosted" && item.hostedTask?.phase !== "review"
    && !item.schedule && (!item.origin || item.origin === "chat") && !item.parentMessageId
    && !work.some(child => child.rootId === item.id && (child.runIds.length || child.currentRunId || child.status !== "queued")))
    .sort(compareQueuedWork);
}

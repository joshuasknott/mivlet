import type { CollaborationWorkItem } from "@fable/protocol";
import { activeWork } from "../../lib/workspace-execution";

/** Work whose outcome blocks the person, ordered newest first. */
export const needsAttention = (work: CollaborationWorkItem) =>
  ["awaiting-approval", "awaiting-user", "failed", "blocked"].includes(
    work.status,
  );

/**
 * Attention first, then active work, then finished history. A completed item
 * can never push a pending approval or failure out of the first positions.
 */
export function attentionOrder(
  work: CollaborationWorkItem[],
): CollaborationWorkItem[] {
  return [...work].sort((a, b) => {
    const rank = (item: CollaborationWorkItem) =>
      needsAttention(item) ? 0 : activeWork(item) ? 1 : 2;
    const byRank = rank(a) - rank(b);
    if (byRank) return byRank;
    if (rank(a) === 1) return a.createdAt.localeCompare(b.createdAt);
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

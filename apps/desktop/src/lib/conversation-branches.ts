import type { ConversationMessageView } from "./conversation-runtime";
import type { CollaborationWorkItem } from "@mivlet/protocol";

const ACTIVE_BRANCH_ACTION_STATUSES = new Set<CollaborationWorkItem["status"]>([
  "queued",
  "running",
  "waiting",
  "awaiting-approval",
]);

/**
 * Branch mutations create a new request and therefore must not race work that
 * may still produce an external effect. Keep this check shared by the
 * assistant-ui callbacks and the branch picker so a stale click cannot take a
 * different path around the same policy.
 */
export function branchActionBlockReason(
  work: readonly CollaborationWorkItem[],
): string | undefined {
  if (work.some((item) => ACTIVE_BRANCH_ACTION_STATUSES.has(item.status))) {
    return "Stop or finish current work before editing, regenerating, or switching conversation alternatives.";
  }
  if (
    work.some(
      (item) =>
        item.status === "blocked" ||
        (item.status === "awaiting-user" && item.runIds.length > 0),
    )
  ) {
    return "Review and reconcile interrupted or failed work before editing, regenerating, or switching conversation alternatives.";
  }
  return undefined;
}

export interface ConversationBranchNode {
  message: ConversationMessageView;
  children: ConversationBranchNode[];
}

/** Build an ordered tree from durable parent links, tolerating legacy rows. */
export function buildConversationBranchTree(
  views: readonly ConversationMessageView[],
): ConversationBranchNode[] {
  const nodes = new Map<string, ConversationBranchNode>();
  for (const view of views) nodes.set(String(view.message.id), { message: view, children: [] });
  const roots: ConversationBranchNode[] = [];
  for (const view of [...views].sort((a, b) => a.message.sequence - b.message.sequence)) {
    const node = nodes.get(String(view.message.id))!;
    const parentKey = parentId(view);
    const parent = parentKey ? nodes.get(String(parentKey)) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function parentId(view: ConversationMessageView) {
  return view.message.parentMessageId === undefined ? view.message.previousMessageId : view.message.parentMessageId;
}

/**
 * Resolve any assistant-ui action back to the user message that owns the
 * branch. Native conversation submission accepts user-message anchors only;
 * assistant responses and tool rows therefore walk their durable parents.
 */
export function branchInputMessageId(
  views: readonly ConversationMessageView[],
  messageId: string,
): string | undefined {
  const byId = new Map(views.map((view) => [String(view.message.id), view]));
  let current = byId.get(String(messageId));
  const seen = new Set<string>();
  while (current && !seen.has(String(current.message.id))) {
    const currentId = String(current.message.id);
    seen.add(currentId);
    if (current.message.kind === "user") return currentId;
    const parent = parentId(current);
    current = parent ? byId.get(String(parent)) : undefined;
  }
  return undefined;
}

/** Return the root-to-head path used by the visible assistant-ui branch. */
export function visibleConversationBranch(
  views: readonly ConversationMessageView[],
  headId?: string,
): ConversationMessageView[] {
  if (!views.length) return [];
  const byId = new Map<string, ConversationMessageView>(views.map((view) => [String(view.message.id), view]));
  if (headId && !byId.has(headId)) return [];
  let current: ConversationMessageView | undefined = (headId ? byId.get(headId) : undefined) ?? [...views].sort((a, b) => b.message.sequence - a.message.sequence)[0];
  const path: ConversationMessageView[] = [];
  const seen = new Set<string>();
  while (current && !seen.has(String(current.message.id))) {
    path.push(current);
    seen.add(String(current.message.id));
    const parent = parentId(current);
    current = parent ? byId.get(String(parent)) : undefined;
  }
  return path.reverse();
}

/** Return true when the selected branch begins before the loaded history window. */
export function branchHasMissingAncestor(
  views: readonly ConversationMessageView[],
  headId?: string,
): boolean {
  if (!headId) return false;
  const byId = new Map(views.map((view) => [String(view.message.id), view]));
  let current = byId.get(String(headId));
  if (!current) return true;
  const seen = new Set<string>();
  while (current && !seen.has(String(current.message.id))) {
    seen.add(String(current.message.id));
    const parent = parentId(current);
    if (!parent) return false;
    current = byId.get(String(parent));
    if (!current) return true;
  }
  return false;
}

export function branchHeads(views: readonly ConversationMessageView[]): string[] {
  const parents = new Set(views.map(parentId).filter(Boolean).map(String));
  // Tool and approval leaves are durable activity, not selectable responses.
  // Keep every user/assistant leaf so alternatives remain inspectable even
  // when the corresponding content is outside the currently loaded window.
  return views
    .filter(
      (view) =>
        !parents.has(String(view.message.id)) &&
        (view.message.kind === "user" || view.message.kind === "assistant"),
    )
    .sort((a, b) => a.message.sequence - b.message.sequence)
    .map((view) => String(view.message.id));
}

export function branchSiblings(
  views: readonly ConversationMessageView[],
  messageId: string,
): ConversationMessageView[] {
  const selected = views.find((view) => view.message.id === messageId);
  if (!selected) return [];
  const parent = parentId(selected);
  return views
    .filter((view) => parentId(view) === parent)
    .sort((a, b) => a.message.sequence - b.message.sequence);
}

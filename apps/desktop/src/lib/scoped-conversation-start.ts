export interface ConversationStartScope {
  workspaceId: string;
  accountId: string;
  agentId: string;
  projectId?: string;
  conversationKey: string;
}

function sameScope(left: ConversationStartScope, right: ConversationStartScope) {
  return left.workspaceId === right.workspaceId
    && left.accountId === right.accountId
    && left.agentId === right.agentId
    && left.projectId === right.projectId
    && left.conversationKey === right.conversationKey;
}

/** Fence a newly created thread on both sides of the draft move await. */
export async function startScopedConversation<T extends { id: string }>(options: {
  scope: ConversationStartScope;
  currentScope: () => ConversationStartScope;
  createThread: () => Promise<T>;
  moveDraft: (threadId: string) => Promise<void>;
}): Promise<T | null> {
  const thread = await options.createThread();
  if (!sameScope(options.scope, options.currentScope())) return null;
  await options.moveDraft(thread.id);
  if (!sameScope(options.scope, options.currentScope())) return null;
  return thread;
}

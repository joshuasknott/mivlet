import { describe, expect, it, vi } from "vitest";
import { startScopedConversation, type ConversationStartScope } from "./scoped-conversation-start";

const scope = (agentId: string, conversationKey = `composer:${agentId}`): ConversationStartScope => ({
  workspaceId: "workspace-a",
  accountId: "account-a",
  agentId,
  conversationKey,
});

describe("startScopedConversation", () => {
  it("does not move or queue an old draft when navigation changes during thread creation", async () => {
    let finishCreate!: (thread: { id: string }) => void;
    let current = scope("chief");
    const moveDraft = vi.fn(async () => {});
    const pending = startScopedConversation({
      scope: current,
      currentScope: () => current,
      createThread: () => new Promise<{ id: string }>((resolve) => { finishCreate = resolve; }),
      moveDraft,
    });
    current = scope("new-agent");
    finishCreate({ id: "thread-created-for-chief" });
    await expect(pending).resolves.toBeNull();
    expect(moveDraft).not.toHaveBeenCalled();
  });

  it("rejects a late scope change after moving the captured draft", async () => {
    let current = scope("chief");
    const pending = startScopedConversation({
      scope: current,
      currentScope: () => current,
      createThread: async () => ({ id: "thread-chief" }),
      moveDraft: async () => { current = scope("chief", "another-composer"); },
    });
    await expect(pending).resolves.toBeNull();
  });
});

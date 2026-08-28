import { describe, expect, it } from "vitest";
import {
  createConversationRuntime,
  createDurableRunWriter,
  newThreadDraftKey,
  threadDraftKey,
  type ConversationMessageView,
  type ConversationTransport,
  type ConversationThread
} from "./conversation-runtime";

const thread = (over: Partial<ConversationThread> = {}) => ({
  id: "thread-1",
  workspaceId: "workspace-1",
  authority: "local",
  visibility: "member-private",
  ownerMemberId: "member-1",
  schemaVersion: 1,
  revision: 0,
  createdByInternalUserId: "user-1",
  createdAt: "2026-07-11T10:00:00.000Z",
  updatedAt: "2026-07-11T10:00:00.000Z",
  title: "A thread",
  lifecycle: "active",
  messageHead: { lastSequence: 0 },
  ...over
}) as ConversationThread;

function transportFixture(): ConversationTransport & { views: ConversationMessageView[] } {
  const views: ConversationMessageView[] = [];
  return {
    views,
    createThread: async () => thread(),
    listThreads: async () => [thread()],
    getThread: async () => thread({ messageHead: { lastSequence: views.length, lastMessageId: views.at(-1)?.message.id } }),
    updateThread: async () => thread(),
    listMessages: async () => views,
    appendMessage: async (input) => {
      const revision = {
        ...input.initialRevision,
        id: input.initialRevision.revisionId,
        messageId: input.messageId,
        threadId: input.threadId,
        messageRevisionNumber: 1,
        baseMessageRevisionNumber: 0,
        workspaceId: "workspace-1",
        authority: "local",
        visibility: "member-private",
        schemaVersion: 1,
        revision: 0,
        createdByInternalUserId: "user-1",
        createdAt: input.initialRevision.checkpointedAt,
        updatedAt: input.initialRevision.checkpointedAt
      } as any;
      const message = {
        ...input,
        id: input.messageId,
        currentRevisionId: revision.id,
        currentRevisionNumber: 1,
        currentRevisionState: revision.state,
        workspaceId: "workspace-1",
        authority: "local",
        visibility: "member-private",
        schemaVersion: 1,
        revision: 0,
        createdByInternalUserId: "user-1",
        createdAt: input.initialRevision.checkpointedAt,
        updatedAt: input.initialRevision.checkpointedAt
      } as any;
      const view = { message, currentRevision: revision } as ConversationMessageView;
      views.push(view);
      return view;
    },
    reviseMessage: async (input) => {
      const index = views.findIndex((view) => view.message.id === input.messageId);
      const previous = views[index];
      const revision = {
        ...input,
        id: input.revisionId,
        messageRevisionNumber: previous.message.currentRevisionNumber + 1,
        workspaceId: "workspace-1",
        authority: "local",
        visibility: "member-private",
        schemaVersion: 1,
        revision: 0,
        createdByInternalUserId: "user-1",
        createdAt: input.checkpointedAt,
        updatedAt: input.checkpointedAt
      } as any;
      const view = { message: { ...previous.message, currentRevisionId: revision.id, currentRevisionNumber: revision.messageRevisionNumber, currentRevisionState: revision.state }, currentRevision: revision } as ConversationMessageView;
      views[index] = view;
      return view;
    },
    loadDraft: async () => null,
    saveDraft: async (draft) => draft,
    deleteDraft: async () => {}
  };
}

describe("conversation runtime", () => {
  it("uses stable new-conversation and thread draft keys", () => {
    expect(newThreadDraftKey()).toBe("new-thread");
    expect(threadDraftKey("thread-1")).toBe("thread:thread-1");
  });

  it("hydrates a thread in transcript sequence order", async () => {
    const transport = transportFixture();
    transport.views.push(
      { message: { id: "later", threadId: "thread-1", sequence: 2 }, currentRevision: { threadId: "thread-1" } } as any,
      { message: { id: "first", threadId: "thread-1", sequence: 1 }, currentRevision: { threadId: "thread-1" } } as any
    );
    const hydrated = await createConversationRuntime(transport).hydrate("thread-1");
    expect(hydrated?.messages.map((view) => view.message.id)).toEqual(["first", "later"]);
  });

  it("writes checkpointed assistant state with deterministic run keys", async () => {
    const transport = transportFixture();
    const writer = createDurableRunWriter(transport, "thread-1", "run-1");
    await writer.record({ kind: "user", content: "Hello" });
    await writer.checkpointAssistant("Partial");
    await writer.checkpointAssistant("Complete", true);

    expect(transport.views).toHaveLength(2);
    expect(transport.views[0].message.idempotencyKey).toBe("run-1:message:0");
    expect(transport.views[1].currentRevision.content).toBe("Complete");
    expect(transport.views[1].currentRevision.reason).toBe("completion");
  });
});

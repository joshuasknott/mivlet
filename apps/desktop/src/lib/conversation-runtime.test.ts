import { describe, expect, it, vi } from "vitest";
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
    await writer.record({ kind: "user", content: "Hello", attachments: [{
      id: "attachment-1", name: "totals.csv", mimeType: "text/csv", sizeBytes: 24,
      availability: "workspace-file", relativePath: "Attachments/totals-a1.csv",
    }] });
    await writer.checkpointAssistant("Partial");
    await writer.checkpointAssistant("Complete", true);

    expect(transport.views).toHaveLength(2);
    expect(transport.views[0].message.idempotencyKey).toBe("run-1:message:0");
    expect(transport.views[0].message.detail).toEqual({ attachments: [{
      id: "attachment-1", name: "totals.csv", mimeType: "text/csv", sizeBytes: 24,
      availability: "workspace-file", relativePath: "Attachments/totals-a1.csv",
    }] });
    expect(transport.views[1].currentRevision.content).toBe("Complete");
    expect(transport.views[1].currentRevision.reason).toBe("completion");
  });

  it("appends from the thread head without loading historical messages", async () => {
    const transport = transportFixture();
    transport.getThread = vi.fn(async () => thread({
      messageHead: { lastSequence: 10_000, lastMessageId: "previous-message" as never }
    }));
    transport.listMessages = vi.fn(async () => { throw new Error("History must not be loaded for writing."); });
    const writer = createDurableRunWriter(transport, "thread-1", "run-1");
    await writer.record({ kind: "user", content: "Continue" });
    await writer.checkpointAssistant("Done", true);

    expect(transport.listMessages).not.toHaveBeenCalled();
    expect(transport.getThread).toHaveBeenCalledTimes(1);
    expect(transport.views.map((view) => view.message.sequence)).toEqual([10_001, 10_002]);
    expect(transport.views[0].message.previousMessageId).toBe("previous-message");
    expect(transport.views[1].message.previousMessageId).toBe(transport.views[0].message.id);
  });

  it("rejects writes when the thread no longer exists", async () => {
    const transport = transportFixture();
    transport.getThread = async () => null;
    const writer = createDurableRunWriter(transport, "thread-1", "run-1");
    await expect(writer.record({ kind: "user", content: "Hello" })).rejects.toThrow("no longer exists");
    expect(transport.views).toHaveLength(0);
  });

  it("keeps updates on either side of tools in order with unique revision keys", async () => {
    const transport = transportFixture();
    const writer = createDurableRunWriter(transport, "thread-1", "run-1");
    await writer.record({ kind: "user", content: "Check it" });
    await writer.checkpointAssistant("I will check. ");
    await writer.record({ kind: "tool-call", content: "Requested", callId: "call-1", toolName: "read-file" });
    await writer.record({ kind: "tool-result", content: "Found it", callId: "call-1", toolName: "read-file", ok: true });
    await writer.checkpointAssistant("I will check. Here is the ");
    await writer.checkpointAssistant("I will check. Here is the answer.", true);
    expect(transport.views.map((view) => view.currentRevision.content)).toEqual(["Check it", "I will check. ", "Requested", "Found it", "Here is the answer."]);
    expect(transport.views[1].currentRevision.state).toBe("terminal");
    expect(new Set(transport.views.map((view) => view.currentRevision.id)).size).toBe(5);
  });

  it("redacts tool arguments and results before they are persisted for replay", async () => {
    const transport = transportFixture();
    const writer = createDurableRunWriter(transport, "thread-1", "run-1");
    await writer.record({
      kind: "tool-call",
      content: JSON.stringify({ command: "env", token: "super-secret-token" }),
      callId: "call-secret",
      toolName: "run-shell"
    });
    await writer.record({
      kind: "tool-result",
      content: "Authorization: Bearer abcdefghij1234567890 and sk-ant-12345678901234567890",
      callId: "call-secret",
      toolName: "run-shell",
      ok: true
    });
    await writer.record({
      kind: "error",
      content: "provider failed: token=leaked-refresh-token",
      code: "provider-error",
      retryable: true
    });

    expect(transport.views[0].currentRevision.content).toContain("[REDACTED]");
    expect(transport.views[0].currentRevision.content).not.toContain("super-secret-token");
    expect(transport.views[1].currentRevision.content).toContain("[REDACTED]");
    expect(transport.views[1].currentRevision.content).not.toContain("abcdefghij1234567890");
    expect(transport.views[1].currentRevision.content).not.toContain("sk-ant-");
    expect(transport.views[2].currentRevision.content).toContain("[REDACTED]");
    expect(transport.views[2].currentRevision.content).not.toContain("leaked-refresh-token");
  });

  it("redacts GitHub, Slack, and Google token shapes that used to survive TypeScript-only patterns", async () => {
    const transport = transportFixture();
    const writer = createDurableRunWriter(transport, "thread-1", "run-1");
    await writer.record({
      kind: "tool-result",
      content: [
        "ghp_abcdefghijklmnopqrstuvwx1234567890",
        "github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz012345",
        "xoxb-fixturenotarealslacktoken",
        "AIzaSy123456789012345678901234567890abc",
        "ya29.a0ATt-leaked-google-access-token"
      ].join("\n"),
      callId: "call-gaps",
      toolName: "run-shell",
      ok: true
    });
    await writer.record({
      kind: "tool-result",
      content: "export GITHUB_TOKEN=ghp_short",
      callId: "call-omit",
      toolName: "run-shell",
      ok: true
    });

    const redacted = transport.views[0].currentRevision.content;
    expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwx1234567890");
    expect(redacted).not.toContain("github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz012345");
    expect(redacted).not.toContain("xoxb-fixturenotarealslacktoken");
    expect(redacted).not.toContain("AIzaSy123456789012345678901234567890abc");
    expect(redacted).not.toContain("ya29.a0ATt-leaked-google-access-token");
    expect(redacted).toContain("[REDACTED]");
    expect(transport.views[1].currentRevision.content).toBe("[content omitted: secret-shaped content]");
  });

  it("redacts assistant checkpoints and non-tool durable kinds before persist", async () => {
    const transport = transportFixture();
    const writer = createDurableRunWriter(transport, "thread-1", "run-1");
    await writer.record({
      kind: "user",
      content: "paste ghp_abcdefghijklmnopqrstuvwx1234567890"
    });
    await writer.checkpointAssistant("I saw ghp_abcdefghijklmnopqrstuvwx1234567890");
    await writer.record({
      kind: "interruption",
      content: "stopped after xoxb-fixturenotarealslacktoken",
      reason: "user-stop"
    });

    expect(transport.views[0].currentRevision.content).not.toContain("ghp_abcdefghijklmnopqrstuvwx1234567890");
    expect(transport.views[1].currentRevision.content).not.toContain("ghp_abcdefghijklmnopqrstuvwx1234567890");
    expect(transport.views[2].currentRevision.content).not.toContain("xoxb-fixturenotarealslacktoken");
    expect(transport.views[0].currentRevision.content).toContain("[REDACTED]");
    expect(transport.views[1].currentRevision.content).toContain("[REDACTED]");
  });
});

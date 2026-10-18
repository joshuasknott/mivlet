import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollaborationWorkItem } from "@mivlet/protocol";
import { createConversationSubmission } from "./conversation-submission";

vi.mock("../lib/execution-attachments", () => ({
  prepareExecutionAttachments: vi.fn(),
}));
vi.mock("../lib/composer-attachments", () => ({
  composerSubmissionText: (text: string) => text,
}));

import { prepareExecutionAttachments } from "../lib/execution-attachments";

type Options = Parameters<typeof createConversationSubmission>[0];

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function fixture(overrides: Partial<Options> = {}) {
  const composer = {
    ready: true,
    text: "Review this",
    attachments: [],
    replyWorkId: undefined,
    outcomeGoal: undefined,
    revision: 1,
    beginSubmission: vi.fn(() => true),
    endSubmission: vi.fn(),
    consume: vi.fn().mockResolvedValue(undefined),
  } as unknown as Options["composer"];
  const runtime = {
    flushSnapshot: vi.fn().mockResolvedValue(undefined),
  } as unknown as Options["runtime"];
  const service = {
    workspaceId: "workspace-1",
    refresh: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    submit: vi.fn().mockResolvedValue(undefined),
  } as unknown as Options["service"];
  const appScope = {
    current: { active: true, roomId: "room-1", generation: 4 },
  } as Options["appScope"];
  const submissionScope = {
    current: {
      owner: { internalUserId: "user-1", memberId: "member-1" },
      responderId: "agent-1",
      localAgentId: "agent-1",
    },
  } as Options["submissionScope"];
  const options: Options = {
    composer,
    runtime,
    service,
    room: { id: "room-1", generation: 4 } as Options["room"],
    owner: { internalUserId: "user-1", memberId: "member-1" },
    responder: { id: "agent-1" } as Options["responder"],
    recipient: "agent-1",
    mentions: null,
    workspaceMentions: {
      recipientIds: [],
      mentions: [],
      errors: [],
      assignment: null,
      shouldExecute: false,
    },
    localComputer: {
      prepareForTool: vi.fn().mockResolvedValue(undefined),
    } as unknown as Options["localComputer"],
    voice: { isBusy: false },
    appScope,
    submissionScope,
    submission: { current: false },
    branchParentMessageId: undefined,
    setBranchParentMessageId: vi.fn() as Options["setBranchParentMessageId"],
    setPending: vi.fn() as Options["setPending"],
    setError: vi.fn() as Options["setError"],
    stageOutputRevision: vi
      .fn()
      .mockResolvedValue(undefined) as Options["stageOutputRevision"],
    clearOutputRevision: vi.fn() as Options["clearOutputRevision"],
    onProjectUpdate: vi.fn().mockResolvedValue(undefined),
    scrollToLatest: vi.fn(),
    ...overrides,
  };
  return { options, composer, runtime, service, appScope, submissionScope };
}

afterEach(() => vi.clearAllMocks());

describe("conversation submission lifecycle", () => {
  it("admits only one send while the first request is awaiting a snapshot", async () => {
    const pending = deferred<void>();
    const { options, composer, runtime, service } = fixture();
    runtime.flushSnapshot = vi.fn(() => pending.promise);
    const send = createConversationSubmission(options);

    const first = send();
    const second = send();
    expect(composer.beginSubmission).toHaveBeenCalledTimes(1);
    expect(service.submit).not.toHaveBeenCalled();

    pending.resolve();
    await first;
    await second;
    expect(service.submit).toHaveBeenCalledTimes(1);
    expect(composer.endSubmission).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft and rejects submission when the responder fence changes during staging", async () => {
    const { options, service, submissionScope } = fixture({
      composer: {
        ready: true,
        text: "Attach this",
        attachments: [
          {
            id: "attachment-1",
            name: "notes.txt",
            type: "text/plain",
            sizeBytes: 5,
            transientBytes: new Uint8Array([1, 2, 3]),
          },
        ],
        revision: 1,
        beginSubmission: vi.fn(() => true),
        endSubmission: vi.fn(),
        consume: vi.fn().mockResolvedValue(undefined),
      } as unknown as Options["composer"],
    });
    vi.mocked(prepareExecutionAttachments).mockImplementation(
      async (_attachments, _computer, _workspaceId, _agentId, isCurrent) => {
        submissionScope.current.responderId = "new-agent";
        expect(isCurrent()).toBe(false);
        return { attachments: [], node: null };
      },
    );

    await createConversationSubmission(options)();

    expect(service.submit).not.toHaveBeenCalled();
    expect(options.composer.consume).not.toHaveBeenCalled();
    expect(options.setError).toHaveBeenCalledWith(
      "The conversation or account changed before this request was saved. Your draft has been kept.",
    );
    expect(options.composer.endSubmission).toHaveBeenCalledTimes(1);
  });

  it("uses the selected assignment id and generation for replies", async () => {
    const replyTarget = {
      id: "work-7",
      generation: 12,
      agentId: "agent-1",
    } as CollaborationWorkItem;
    const { options, composer, service } = fixture({
      composer: {
        ready: true,
        text: "Follow up",
        attachments: [],
        replyWorkId: "work-7",
        revision: 1,
        beginSubmission: vi.fn(() => true),
        endSubmission: vi.fn(),
        consume: vi.fn().mockResolvedValue(undefined),
      } as unknown as Options["composer"],
      replyTarget,
    });

    await createConversationSubmission(options)();

    expect(service.reply).toHaveBeenCalledWith("work-7", 12, "Follow up");
    expect(service.submit).not.toHaveBeenCalled();
    expect(options.stageOutputRevision).toHaveBeenCalledWith(
      expect.objectContaining({ replying: true }),
    );
  });

  it("releases the lock after a failure without consuming the draft", async () => {
    const { options, composer, runtime, service } = fixture();
    runtime.flushSnapshot = vi
      .fn()
      .mockRejectedValueOnce(new Error("snapshot unavailable"))
      .mockResolvedValue(undefined);
    const send = createConversationSubmission(options);

    await send();
    expect(composer.consume).not.toHaveBeenCalled();
    expect(options.setError).toHaveBeenCalledWith("snapshot unavailable");

    await send();
    expect(service.submit).toHaveBeenCalledTimes(1);
    expect(composer.beginSubmission).toHaveBeenCalledTimes(2);
  });
});

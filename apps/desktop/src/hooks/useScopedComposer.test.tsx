import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeConversationDraft, saveRuntimeConversationDraft } from "../runtime/domains/conversations";
import type { ComposerScope } from "./useScopedComposer";
import { composerScopeKey, useScopedComposer } from "./useScopedComposer";

const mocks = vi.hoisted(() => ({
  drafts: new Map<string, { draftKey: string; threadId?: string; content: string; updatedAt: string }>(),
  saves: [] as { draftKey: string; threadId?: string; content: string }[],
}));

type StoredDraft = { draftKey: string; threadId?: string; content: string; updatedAt: string };
const deferred = () => {
  let resolve!: (draft: StoredDraft | null) => void;
  const promise = new Promise<StoredDraft | null>((res) => { resolve = res; });
  return { promise, resolve };
};
const storedContent = (text: string) => JSON.stringify({ text, attachments: [] });

vi.mock("../runtime/domains/conversations", () => ({
loadRuntimeConversationDraft: vi.fn(async (key: string) => mocks.drafts.get(key) ?? null),
saveRuntimeConversationDraft: vi.fn(async (draft) => {
    mocks.saves.push(draft);
    mocks.drafts.set(draft.draftKey, draft);
    return draft;
  })
}));

let testScope = 0;
const scope = (agentId: string, threadId?: string): ComposerScope => ({
  workspaceId: "workspace-a",
  accountId: `account-a:member-a:${testScope}`,
  agentId,
  threadId,
});

describe("useScopedComposer", () => {
  beforeEach(() => {
    testScope++;
    vi.useFakeTimers();
    mocks.drafts.clear();
    mocks.saves.length = 0;
    vi.mocked(loadRuntimeConversationDraft).mockReset().mockImplementation(async (key: string) => mocks.drafts.get(key) ?? null);
  });
  afterEach(() => vi.useRealTimers());

  it("notifies matching panes without rerendering unrelated or inactive composers on each edit", async () => {
    const first = renderHook(() => useScopedComposer(scope("chief", "shared")));
    const sharedRender = vi.fn(() => useScopedComposer(scope("chief", "shared")));
    const separateRender = vi.fn(() => useScopedComposer(scope("chief", "separate")));
    const inactiveRender = vi.fn(() => useScopedComposer());
    const shared = renderHook(sharedRender);
    renderHook(separateRender);
    renderHook(inactiveRender);
    await act(async () => {});
    sharedRender.mockClear();
    separateRender.mockClear();
    inactiveRender.mockClear();

    for (let index = 1; index <= 20; index++) {
      act(() => first.result.current.setText(`Draft ${index}`));
    }

    expect(shared.result.current.text).toBe("Draft 20");
    expect(sharedRender).toHaveBeenCalledTimes(20);
    expect(separateRender).not.toHaveBeenCalled();
    expect(inactiveRender).not.toHaveBeenCalled();
  });

  it("notifies the saved scope after switching panes and stops listening to the previous scope", async () => {
    const oldScope = scope("chief", "old-save");
    const nextScope = scope("chief", "next-save");
    const render = vi.fn(({ value }: { value: ComposerScope }) => useScopedComposer(value));
    const pane = renderHook(render, { initialProps: { value: oldScope } });
    const oldPane = renderHook(() => useScopedComposer(oldScope));
    const nextPane = renderHook(() => useScopedComposer(nextScope));
    await act(async () => {});
    act(() => pane.result.current.setText("pending save"));
    let rejectSave!: (error: Error) => void;
    vi.mocked(saveRuntimeConversationDraft).mockImplementationOnce(() => new Promise((_, reject) => { rejectSave = reject; }));
    let saving!: Promise<unknown>;
    await act(async () => { saving = pane.result.current.flush().catch(() => undefined); });
    pane.rerender({ value: nextScope });
    render.mockClear();

    await act(async () => { rejectSave(new Error("Could not save the old draft")); await saving; });
    expect(oldPane.result.current.error).toBe("Could not save the old draft");
    expect(pane.result.current.error).toBe("");
    expect(render).not.toHaveBeenCalled();

    act(() => oldPane.result.current.setText("old scope edit"));
    expect(render).not.toHaveBeenCalled();
    act(() => nextPane.result.current.setText("new scope edit"));
    expect(render).toHaveBeenCalledOnce();
    expect(pane.result.current.text).toBe("new scope edit");
  });

  it("persists follow-up assignment identity with the conversation draft and clears it when sent", async () => {
    const currentScope = scope("lead", "reply-room");
    const first = renderHook(() => useScopedComposer(currentScope));
    await act(async () => {});
    act(() => { first.result.current.setReplyWork("assignment-a"); first.result.current.setText("The UK market"); });
    await act(async () => first.result.current.flush());
    expect(JSON.parse(mocks.drafts.get(composerScopeKey(currentScope))!.content).replyWorkId).toBe("assignment-a");
    const duplicate = renderHook(() => useScopedComposer(currentScope));
    await act(async () => {});
    expect(duplicate.result.current.replyWorkId).toBe("assignment-a");
    const separate = renderHook(() => useScopedComposer(scope("lead", "other-reply-room")));
    await act(async () => {});
    expect(separate.result.current.replyWorkId).toBeUndefined();
    await act(async () => first.result.current.consume(first.result.current.revision));
    expect(duplicate.result.current.replyWorkId).toBeUndefined();
  });

  it("shares recipient, text and one submission lock across duplicate views, while another conversation stays private", async () => {
    const first = renderHook(() => useScopedComposer(scope("chief", "same-room")));
    const second = renderHook(() => useScopedComposer(scope("chief", "same-room")));
    const separate = renderHook(() => useScopedComposer(scope("chief", "private-room")));
    await act(async () => {});
    act(() => { first.result.current.setText("shared unsent text"); first.result.current.setRecipient("reviewer"); });
    expect(second.result.current.text).toBe("shared unsent text");
    expect(second.result.current.recipientId).toBe("reviewer");
    expect(separate.result.current.text).toBe("");
    act(() => { expect(first.result.current.beginSubmission()).toBe(true); expect(second.result.current.beginSubmission()).toBe(false); });
    const sentRevision = first.result.current.revision;
    act(() => second.result.current.setText("next message typed while saving"));
    await act(async () => first.result.current.consume(sentRevision));
    expect(second.result.current.text).toBe("next message typed while saving");
    act(() => first.result.current.endSubmission());
    await act(async () => { await first.result.current.flush(); first.unmount(); });
    expect(second.result.current.text).toBe("next message typed while saving");
  });

  it("saves a reviewed handoff separately from source and unsent new-conversation drafts", async () => {
    const { result, rerender } = renderHook(
      ({ value }) => useScopedComposer(value),
      { initialProps: { value: scope("chief") } },
    );
    await act(async () => {});
    act(() => result.current.setText("keep unsent new draft"));
    await act(async () => result.current.flush());

    rerender({ value: scope("chief", "source-thread") });
    await act(async () => {});
    act(() => {
      result.current.setText("keep source draft");
      result.current.setAttachments(() => [{
        id: "private",
        name: "private.txt",
        type: "text/plain",
        sizeBytes: 5,
        sourceId: "private-source",
      }]);
    });
    await act(async () => result.current.flush());
    await act(async () => result.current.saveNewThreadDraft("continuation-thread", "review this handoff"));

    expect(result.current.text).toBe("keep source draft");
    expect(result.current.attachments).toHaveLength(1);
    rerender({ value: scope("chief", "continuation-thread") });
    await act(async () => {});
    expect(result.current.text).toBe("review this handoff");
    expect(result.current.attachments).toEqual([]);
    rerender({ value: scope("chief") });
    await act(async () => {});
    expect(result.current.text).toBe("keep unsent new draft");
  });

  it("rejects a late handoff write after the account changes", async () => {
    const { result, rerender } = renderHook(
      ({ value }) => useScopedComposer(value),
      { initialProps: { value: scope("chief", "source-thread") } },
    );
    await act(async () => {});
    const saveHandoff = result.current.saveNewThreadDraft;
    rerender({ value: { ...scope("chief", "source-thread"), accountId: "different-account" } });
    await act(async () => {});

    await expect(saveHandoff("continuation-thread", "private handoff")).rejects.toThrow();
    expect(mocks.saves).toEqual([]);
  });

  it("keeps text and late attachment ingestion in the scope that started them", async () => {
    const { result, rerender } = renderHook(
      ({ value }) => useScopedComposer(value),
      { initialProps: { value: scope("chief", "thread-chief") } },
    );
    await act(async () => {});
    expect(result.current.ready).toBe(true);
    act(() => result.current.setText("chief draft"));
    const finishChiefAttachment = result.current.setAttachments;

    rerender({ value: scope("new-agent") });
    await act(async () => {});
    expect(result.current.text).toBe("");
    expect(result.current.attachments).toEqual([]);

    act(() => finishChiefAttachment((current) => [...current, {
      id: "private-source",
      name: "private.txt",
      type: "text/plain",
      sizeBytes: 12,
      sourceId: "source-private",
      transientBytes: new Uint8Array([112, 114, 105, 118, 97, 116, 101]),
    }]));
    expect(result.current.attachments).toEqual([]);

    await act(async () => { vi.runAllTimers(); await Promise.resolve(); });
    expect(mocks.saves.some((draft) => draft.draftKey === composerScopeKey(scope("chief", "thread-chief")) && draft.content.includes("source-private"))).toBe(true);
    expect(mocks.saves.every((draft) => !draft.content.includes("transientBytes"))).toBe(true);
    expect(mocks.saves.some((draft) => draft.draftKey === composerScopeKey(scope("new-agent")) && draft.content.includes("source-private"))).toBe(false);
  });

  it("moves a new-conversation draft once and serializes its sent clear after pending saves", async () => {
    const initial = scope("agent-a");
    const destination = scope("agent-a", "thread-created");
    const { result, rerender } = renderHook(
      ({ value }) => useScopedComposer(value),
      { initialProps: { value: initial } },
    );
    await act(async () => {});
    act(() => {
      result.current.setText("send exactly once");
      result.current.setAttachments(() => [{
        id: "source-a",
        name: "brief.txt",
        type: "text/plain",
        sizeBytes: 20,
        sourceId: "knowledge-a",
      }]);
    });
    await act(async () => result.current.moveToThread("thread-created"));

    rerender({ value: destination });
    expect(result.current.text).toBe("send exactly once");
    expect(result.current.attachments[0]?.sourceId).toBe("knowledge-a");
    await act(async () => { await result.current.consume(); });
    await act(async () => { vi.runAllTimers(); await Promise.resolve(); });

    const destinationWrites = mocks.saves.filter((draft) => draft.draftKey === composerScopeKey(destination));
    expect(JSON.parse(destinationWrites.at(-1)!.content)).toEqual({ text: "", attachments: [] });
    const originWrites = mocks.saves.filter((draft) => draft.draftKey === composerScopeKey(initial));
    expect(JSON.parse(originWrites.at(-1)!.content)).toEqual({ text: "", attachments: [] });
  });

  it("does not repaint a new scope when an older load resolves late", async () => {
    let resolveOld!: (value: null) => void;
    const load = vi.mocked((await import("../runtime/domains/conversations")).loadRuntimeConversationDraft);
    load.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const { result, rerender } = renderHook(
      ({ value }) => useScopedComposer(value),
      { initialProps: { value: scope("old", "thread-old") } },
    );
    rerender({ value: scope("new", "thread-new") });
    await act(async () => {});
    expect(result.current.ready).toBe(true);
    act(() => resolveOld(null));
    await act(async () => {});
    expect(result.current.text).toBe("");
    expect(result.current.key).toBe(composerScopeKey(scope("new", "thread-new")));
  });

  it("migrates an owned legacy thread draft but never imports the global new-thread draft", async () => {
    mocks.drafts.set("thread:owned", {
      draftKey: "thread:owned",
      threadId: "owned",
      content: "legacy owned text",
      updatedAt: "2026-09-10T12:00:00Z",
    });
    mocks.drafts.set("new-thread", {
      draftKey: "new-thread",
      content: "unsafe global text",
      updatedAt: "2026-09-10T12:00:00Z",
    });
    const { result, rerender } = renderHook(
      ({ value }) => useScopedComposer(value),
      { initialProps: { value: scope("agent-a", "owned") } },
    );
    await act(async () => {});
    expect(result.current.text).toBe("legacy owned text");
    await act(async () => { await Promise.resolve(); });
    expect(mocks.saves.some((draft) => draft.draftKey === composerScopeKey(scope("agent-a", "owned")) && draft.content.includes("legacy owned text"))).toBe(true);

    rerender({ value: scope("agent-b") });
    await act(async () => {});
    expect(result.current.text).toBe("");
  });

  it("does not resurrect sent text when a queued re-load catches up after the send", async () => {
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const load = vi.mocked(loadRuntimeConversationDraft);
    load.mockImplementationOnce(() => first.promise);
    load.mockImplementationOnce(() => second.promise);
    load.mockImplementationOnce(() => third.promise);
    const keyA = composerScopeKey(scope("agent-a", "thread-a"));
    const keyB = composerScopeKey(scope("agent-b", "thread-b"));
    const draftA: StoredDraft = { draftKey: keyA, threadId: "thread-a", content: storedContent("stored canary"), updatedAt: "2026-09-11T10:00:00Z" };
    const { result, rerender } = renderHook(
      ({ value }) => useScopedComposer(value),
      { initialProps: { value: scope("agent-a", "thread-a") } },
    );
    await act(async () => {});
    await act(async () => { void result.current.consume(); });
    rerender({ value: scope("agent-b", "thread-b") });
    await act(async () => {});
    rerender({ value: scope("agent-a", "thread-a") });
    await act(async () => {});
    act(() => first.resolve(draftA));
    await act(async () => {});
    expect(result.current.ready).toBe(true);
    expect(result.current.text).toBe("");
    act(() => second.resolve({ ...draftA, draftKey: keyB, threadId: "thread-b", content: storedContent("beta canary") }));
    await act(async () => {});
    act(() => third.resolve(draftA));
    await act(async () => {});
    expect(result.current.text).toBe("");
    const writes = mocks.saves.filter((saved) => saved.draftKey === keyA);
    expect(JSON.parse(writes.at(-1)!.content)).toEqual({ text: "", attachments: [] });
  });

  it("does not overwrite typing with a queued re-load that caught up after the draft loaded", async () => {
    const first = deferred();
    const load = vi.mocked(loadRuntimeConversationDraft);
    load.mockImplementationOnce(() => first.promise);
    const keyA = composerScopeKey(scope("agent-a", "thread-a"));
    const draftA: StoredDraft = { draftKey: keyA, threadId: "thread-a", content: storedContent("stored canary"), updatedAt: "2026-09-11T10:00:00Z" };
    const { result, rerender } = renderHook(
      ({ value }) => useScopedComposer(value),
      { initialProps: { value: scope("agent-a", "thread-a") } },
    );
    await act(async () => {});
    act(() => result.current.setText("typed before the load settled"));
    rerender({ value: scope("agent-b", "thread-b") });
    await act(async () => {});
    rerender({ value: scope("agent-a", "thread-a") });
    await act(async () => {});
    const requeued = deferred();
    load.mockImplementationOnce(() => requeued.promise);
    act(() => first.resolve(draftA));
    await act(async () => {});
    expect(result.current.ready).toBe(true);
    expect(result.current.text).toBe("typed before the load settled");
    act(() => requeued.resolve(draftA));
    await act(async () => {});
    expect(result.current.text).toBe("typed before the load settled");
  });

  it("clears and persists the sent draft exactly once and keeps the clear on revisit", async () => {
    const first = deferred();
    const load = vi.mocked(loadRuntimeConversationDraft);
    load.mockImplementationOnce(() => first.promise);
    const keyA = composerScopeKey(scope("agent-a", "thread-a"));
    const draftA: StoredDraft = { draftKey: keyA, threadId: "thread-a", content: storedContent("alpha canary"), updatedAt: "2026-09-11T10:00:00Z" };
    const { result, rerender } = renderHook(
      ({ value }) => useScopedComposer(value),
      { initialProps: { value: scope("agent-a", "thread-a") } },
    );
    await act(async () => {});
    act(() => first.resolve(draftA));
    await act(async () => {});
    expect(result.current.text).toBe("alpha canary");
    act(() => result.current.setText("sending now"));
    await act(async () => { void result.current.consume(); });
    expect(result.current.text).toBe("");
    await act(async () => { vi.runAllTimers(); await Promise.resolve(); });
    const writes = mocks.saves.filter((saved) => saved.draftKey === keyA);
    expect(JSON.parse(writes.at(-1)!.content)).toEqual({ text: "", attachments: [] });
    rerender({ value: scope("agent-b", "thread-b") });
    await act(async () => {});
    rerender({ value: scope("agent-a", "thread-a") });
    await act(async () => {});
    expect(result.current.text).toBe("");
  });

  it("keeps the caller's restored prompt after a failed send", async () => {
    const first = deferred();
    const load = vi.mocked(loadRuntimeConversationDraft);
    load.mockImplementationOnce(() => first.promise);
    const keyA = composerScopeKey(scope("agent-a", "thread-a"));
    const draftA: StoredDraft = { draftKey: keyA, threadId: "thread-a", content: storedContent("alpha canary"), updatedAt: "2026-09-11T10:00:00Z" };
    const { result } = renderHook(
      ({ value }) => useScopedComposer(value),
      { initialProps: { value: scope("agent-a", "thread-a") } },
    );
    await act(async () => {});
    act(() => first.resolve(draftA));
    await act(async () => {});
    act(() => result.current.setText("will fail"));
    await act(async () => { void result.current.consume(); });
    expect(result.current.text).toBe("");
    act(() => result.current.setText("retry prompt"));
    await act(async () => { vi.runAllTimers(); await Promise.resolve(); });
    expect(result.current.text).toBe("retry prompt");
    const writes = mocks.saves.filter((saved) => saved.draftKey === keyA);
    expect(JSON.parse(writes.at(-1)!.content)).toEqual({ text: "retry prompt", attachments: [] });
  });

  it("keeps distinct drafts across rapid scope switches with out-of-order restorations", async () => {
    const first = deferred();
    const second = deferred();
    const load = vi.mocked(loadRuntimeConversationDraft);
    load.mockImplementationOnce(() => first.promise);
    load.mockImplementationOnce(() => second.promise);
    const keyA = composerScopeKey(scope("agent-a", "thread-a"));
    const keyB = composerScopeKey(scope("agent-b", "thread-b"));
    const draftA: StoredDraft = { draftKey: keyA, threadId: "thread-a", content: storedContent("alpha canary"), updatedAt: "2026-09-11T10:00:00Z" };
    const draftB: StoredDraft = { ...draftA, draftKey: keyB, threadId: "thread-b", content: storedContent("beta canary") };
    const { result, rerender } = renderHook(
      ({ value }) => useScopedComposer(value),
      { initialProps: { value: scope("agent-a", "thread-a") } },
    );
    await act(async () => {});
    rerender({ value: scope("agent-b", "thread-b") });
    await act(async () => {});
    rerender({ value: scope("agent-a", "thread-a") });
    await act(async () => {});
    rerender({ value: scope("agent-b", "thread-b") });
    await act(async () => {});
    const requeuedB = deferred();
    load.mockImplementationOnce(() => requeuedB.promise);
    act(() => second.resolve(draftB));
    await act(async () => {});
    expect(result.current.text).toBe("beta canary");
    const requeuedA = deferred();
    load.mockImplementationOnce(() => requeuedA.promise);
    act(() => first.resolve(draftA));
    await act(async () => {});
    expect(result.current.text).toBe("beta canary");
    act(() => requeuedB.resolve(draftB));
    await act(async () => {});
    expect(result.current.text).toBe("beta canary");
    rerender({ value: scope("agent-a", "thread-a") });
    await act(async () => {});
    expect(result.current.text).toBe("alpha canary");
    act(() => requeuedA.resolve(draftA));
    await act(async () => {});
    expect(result.current.text).toBe("alpha canary");
    rerender({ value: scope("agent-b", "thread-b") });
    await act(async () => {});
    expect(result.current.text).toBe("beta canary");
  });

  it("does not clear another scope's draft when sending from the current scope", async () => {
    const keyA = composerScopeKey(scope("agent-a", "thread-a"));
    const keyB = composerScopeKey(scope("agent-b", "thread-b"));
    mocks.drafts.set(keyA, { draftKey: keyA, threadId: "thread-a", content: storedContent("alpha draft"), updatedAt: "2026-09-11T10:00:00Z" });
    mocks.drafts.set(keyB, { draftKey: keyB, threadId: "thread-b", content: storedContent("beta draft"), updatedAt: "2026-09-11T10:00:00Z" });
    const { result, rerender } = renderHook(
      ({ value }) => useScopedComposer(value),
      { initialProps: { value: scope("agent-a", "thread-a") } },
    );
    await act(async () => {});
    expect(result.current.text).toBe("alpha draft");
    rerender({ value: scope("agent-b", "thread-b") });
    await act(async () => {});
    expect(result.current.text).toBe("beta draft");
    await act(async () => { void result.current.consume(); });
    await act(async () => { vi.runAllTimers(); await Promise.resolve(); });
    rerender({ value: scope("agent-a", "thread-a") });
    await act(async () => {});
    expect(result.current.text).toBe("alpha draft");
    const alphaWrites = mocks.saves.filter((saved) => saved.draftKey === keyA);
    expect(alphaWrites.length).toBe(0);
    const betaWrites = mocks.saves.filter((saved) => saved.draftKey === keyB);
    expect(JSON.parse(betaWrites.at(-1)!.content)).toEqual({ text: "", attachments: [] });
  });
});

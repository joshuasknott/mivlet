import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerScope } from "./useScopedComposer";
import { composerScopeKey, useScopedComposer } from "./useScopedComposer";

const mocks = vi.hoisted(() => ({
  drafts: new Map<string, { draftKey: string; threadId?: string; content: string; updatedAt: string }>(),
  saves: [] as { draftKey: string; threadId?: string; content: string }[],
}));

vi.mock("../runtime", () => ({
  loadRuntimeConversationDraft: vi.fn(async (key: string) => mocks.drafts.get(key) ?? null),
  saveRuntimeConversationDraft: vi.fn(async (draft) => {
    mocks.saves.push(draft);
    mocks.drafts.set(draft.draftKey, draft);
    return draft;
  }),
}));

const scope = (agentId: string, threadId?: string): ComposerScope => ({
  workspaceId: "workspace-a",
  accountId: "account-a:member-a",
  agentId,
  threadId,
});

describe("useScopedComposer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.drafts.clear();
    mocks.saves.length = 0;
  });
  afterEach(() => vi.useRealTimers());

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
    const load = vi.mocked((await import("../runtime")).loadRuntimeConversationDraft);
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
});

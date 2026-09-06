import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeConversationDraft } from "./runtime";
import { clearActiveRuntimeDataScope, setActiveRuntimeDataScope } from "./runtime-scope";
import { clearRuntimeAdapterForTest, selectRuntimeAdapterForTest } from "./runtime/adapters/select";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

describe("native conversation drafts", () => {
  const draft = { draftKey: "new-thread", content: "Keep this draft", updatedAt: "2026-09-06T10:00:00Z" };
  beforeEach(() => {
    mocks.invoke.mockReset();
    selectRuntimeAdapterForTest("native");
    setActiveRuntimeDataScope("workspace-a");
  });
  afterEach(() => { clearRuntimeAdapterForTest(); clearActiveRuntimeDataScope(); });

  it("restores a new-conversation draft with a native null thread ID", async () => {
    mocks.invoke.mockResolvedValue({ ...draft, threadId: null });
    await expect(loadRuntimeConversationDraft("new-thread")).resolves.toEqual({ ...draft, threadId: undefined });
  });

  it.each([
    { ...draft, threadId: 42 },
    { ...draft, threadId: null, workspaceId: "workspace-b" },
    { ...draft, content: null },
  ])("still rejects malformed or cross-workspace drafts", async (response) => {
    mocks.invoke.mockResolvedValue(response);
    await expect(loadRuntimeConversationDraft("new-thread")).rejects.toThrow("Malformed or cross-workspace");
  });

  it("keeps a missing draft distinct from invalid data", async () => {
    mocks.invoke.mockResolvedValue(null);
    await expect(loadRuntimeConversationDraft("new-thread")).resolves.toBeNull();
  });
});

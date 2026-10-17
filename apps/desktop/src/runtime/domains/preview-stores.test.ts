import { afterEach, expect, it, vi } from "vitest";
import {
  setActiveRuntimeDataScope,
  clearActiveRuntimeDataScope,
} from "../../runtime-scope";
import {
  selectRuntimeAdapterForTest,
  clearRuntimeAdapterForTest,
} from "../adapters/select";
import {
  createRuntimeConversationThread,
  listRuntimeConversationThreads,
  saveRuntimeConversationDraft,
  loadRuntimeConversationDraft,
} from "./conversations";
import {
  ensureRuntimeOutput,
  appendRuntimeOutputRevision,
  getRuntimeOutput,
} from "./outputs";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
afterEach(() => {
  clearRuntimeAdapterForTest();
  clearActiveRuntimeDataScope();
  mocks.invoke.mockReset();
});

it("retains explicit preview conversations, drafts and workspace isolation in test builds", async () => {
  selectRuntimeAdapterForTest("preview");
  setActiveRuntimeDataScope("preview-a");
  const thread = await createRuntimeConversationThread({
    title: "Preview",
    authorityScope: {
      authority: "local",
      visibility: "member-private",
      ownerMemberId: "preview-user",
    },
  } as Parameters<typeof createRuntimeConversationThread>[0]);
  expect(await listRuntimeConversationThreads()).toEqual([thread]);
  const draft = {
    draftKey: "draft",
    content: "Keep me",
    updatedAt: "2026-10-17T10:00:00Z",
  };
  await saveRuntimeConversationDraft(draft);
  expect(await loadRuntimeConversationDraft("draft")).toEqual(draft);
  setActiveRuntimeDataScope("preview-b");
  expect(await listRuntimeConversationThreads()).toEqual([]);
  expect(await loadRuntimeConversationDraft("draft")).toBeNull();
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("retains preview output revisions and rejects stale writes", async () => {
  selectRuntimeAdapterForTest("preview");
  setActiveRuntimeDataScope("preview-output");
  const output = await ensureRuntimeOutput({
    id: "report",
    title: "Report",
    format: "text",
    mimeType: "text/plain",
    content: "First",
    source: { conversationId: "conversation" },
  });
  const input = {
    outputId: output.id,
    expectedRevisionId: output.currentRevisionId,
    expectedRevisionNumber: output.currentRevisionNumber,
    content: "Second",
    author: "user" as const,
    provenance: {
      conversationId: "conversation",
      reason: "direct-edit" as const,
    },
  };
  const updated = await appendRuntimeOutputRevision(input);
  expect(updated.currentRevisionNumber).toBe(2);
  await expect(appendRuntimeOutputRevision(input)).rejects.toThrow(
    "changed in another pane",
  );
  expect(await getRuntimeOutput(output.id)).toEqual(updated);
  setActiveRuntimeDataScope("other-output-workspace");
  expect(await getRuntimeOutput(output.id)).toBeNull();
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("keeps native output storage authoritative and binds expected workspace", async () => {
  selectRuntimeAdapterForTest("native");
  setActiveRuntimeDataScope("native-output");
  mocks.invoke.mockResolvedValue(null);
  expect(await getRuntimeOutput("report", "native-output")).toBeNull();
  expect(mocks.invoke).toHaveBeenCalledWith("output_get", {
    workspaceId: "native-output",
    outputId: "report",
  });
  await expect(getRuntimeOutput("report", "other-workspace")).rejects.toThrow(
    "selected workspace changed",
  );
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationRestoreReview } from "@mivlet/protocol";
import {
  conversationRestore,
  executeConversationRestore,
  prepareConversationRestore,
} from "./conversation-restore";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  prepare: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("../bridge", () => ({ invokeNative: mocks.invoke }));
vi.mock("./repository-checkpoints", () => ({
  prepareCheckpointAction: mocks.prepare,
  executeCheckpointAction: mocks.execute,
}));
const owner = {
  workspaceId: "default",
  conversationId: "chat",
  agentId: "lead",
};
const review = {
  id: "preview",
  direction: "restore",
  computerGeneration: 7,
  point: { ...owner, repository: { repositoryId: "private-copy" } },
  checkpoint: {
    checkpoint: { id: "checkpoint", treeId: "saved" },
    currentTreeId: "current",
    outputTreeId: "after",
    head: "head",
  },
} as ConversationRestoreReview;
const action = { approval: { id: "exact-approval" } } as ReturnType<
  typeof prepareConversationRestore
>;
beforeEach(() => vi.resetAllMocks());
describe("connected native recovery", () => {
  it("uses exact native copy, generation and reviewed trees in the ordinary checkpoint approval", () => {
    prepareConversationRestore(review);
    expect(mocks.prepare).toHaveBeenCalledWith(
      { workspaceId: "default", agentId: "lead", expectedGeneration: 7 },
      "restore",
      {
        repositoryId: "private-copy",
        checkpointId: "checkpoint",
        expectedTree: "current",
        expectedCheckpointTree: "saved",
        expectedOutput: "after",
        expectedHead: "head",
      },
    );
  });
  it("persists intent before the approved file action and finishes only after native success", async () => {
    const steps: string[] = [];
    mocks.invoke.mockImplementation(async (_command, { request }) => {
      steps.push(request.action);
      return { id: "intent" };
    });
    mocks.execute.mockImplementation(async () => {
      steps.push("approved-file-restore");
    });
    await executeConversationRestore(owner, review, action, "approve");
    expect(steps).toEqual(["stage", "approved-file-restore", "finish"]);
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "conversation_restore", {
      request: {
        ...owner,
        action: "stage",
        previewId: "preview",
        approvalRequestId: "exact-approval",
      },
    });
  });
  it("retains uncertain partial outcome without retry or conversation mutation", async () => {
    mocks.invoke.mockResolvedValue({ id: "intent" });
    mocks.execute.mockRejectedValue(new Error("Native operation interrupted"));
    await expect(
      executeConversationRestore(owner, review, action, "approve"),
    ).rejects.toThrow("interrupted");
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it("requires native custody and never simulates a browser recovery", async () => {
    mocks.invoke.mockResolvedValue(null);
    await expect(
      conversationRestore(owner, { action: "list" }),
    ).rejects.toThrow(/installed desktop/);
  });
});

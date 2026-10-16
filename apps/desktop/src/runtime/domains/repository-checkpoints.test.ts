import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeCheckpointAction,
  prepareCheckpointAction,
  previewRepositoryCheckpoint,
} from "./repository-checkpoints";
const mocks = vi.hoisted(() => ({
  scope: { workspaceId: "workspace", accountId: "account" },
  invoke: vi.fn(),
  resolve: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("../bridge", () => ({
  activeDataScope: () => mocks.scope,
  invokeNative: mocks.invoke,
}));
vi.mock("./approvals", () => ({
  resolveRuntimeApprovalRequest: mocks.resolve,
}));
vi.mock("./tools", () => ({ executeRuntimeToolCall: mocks.execute }));
const target = {
  workspaceId: "workspace",
  agentId: "agent",
  expectedGeneration: 7,
};
const args = {
  repositoryId: "copy",
  checkpointId: "checkpoint",
  expectedTree: "current",
  expectedCheckpointTree: "saved",
  expectedOutput: "restored",
  expectedHead: "head",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope = { workspaceId: "workspace", accountId: "account" };
  mocks.resolve.mockResolvedValue({
    persisted: true,
    dismissed: true,
    auditEntry: { decision: "once" },
  });
  mocks.execute.mockResolvedValue({ ok: true, output: "restored" });
});
describe("native checkpoint authority", () => {
  it("binds complete restore arguments and original scope/generation to one-use approval", async () => {
    const action = prepareCheckpointAction(target, "restore", args);
    expect(action.approval.dataUsed).toContainEqual(
      expect.stringMatching(/^Arguments SHA-256: [a-f0-9]{64}$/),
    );
    expect(action.approval.dataUsed.slice(-3)).toEqual([
      "Computer workspace: workspace",
      "Computer agent: agent",
      "Computer generation: 7",
    ]);
    expect(mocks.execute).not.toHaveBeenCalled();
    await executeCheckpointAction(
      action,
      "approve repository-checkpoint-restore",
    );
    expect(mocks.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "once",
        confirmationText: "approve repository-checkpoint-restore",
      }),
    );
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: args,
        computerGeneration: 7,
        workspaceId: "workspace",
        agentId: "agent",
      }),
    );
  });
  it("rejects account transitions during approval and does not execute", async () => {
    const action = prepareCheckpointAction(target, "restore", args);
    mocks.resolve.mockImplementationOnce(async () => {
      mocks.scope = { workspaceId: "workspace", accountId: "another" };
      return { persisted: true, auditEntry: { decision: "once" } };
    });
    await expect(executeCheckpointAction(action, "typed")).rejects.toThrow(
      "account or workspace changed",
    );
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("does not execute denied/unavailable approval or retry a stale native action", async () => {
    const action = prepareCheckpointAction(target, "restore", args);
    mocks.resolve.mockResolvedValueOnce(null);
    await expect(executeCheckpointAction(action, "")).rejects.toThrow(
      "not approved",
    );
    expect(mocks.execute).not.toHaveBeenCalled();
    mocks.execute.mockRejectedValueOnce(new Error("generation changed"));
    await expect(executeCheckpointAction(action, "typed")).rejects.toThrow(
      "generation changed",
    );
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it("preview remains read-only and names the exact selected copy", async () => {
    await previewRepositoryCheckpoint(target, "copy", "checkpoint");
    expect(mocks.invoke).toHaveBeenCalledWith("coding_checkpoint_inspect", {
      ...target,
      repositoryId: "copy",
      checkpointId: "checkpoint",
    });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

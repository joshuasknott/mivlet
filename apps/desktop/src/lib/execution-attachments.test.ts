import { describe, expect, it, vi } from "vitest";
import type { LocalComputerSnapshot } from "@fable/protocol";
import { prepareExecutionAttachments } from "./execution-attachments";
import { computerToolsReady } from "./computer-tools";

vi.mock("../runtime/domains/local-computer", () => ({
  stageRuntimeLocalComputerAttachment: vi.fn(),
  discardRuntimeLocalComputerAttachmentBatch: vi.fn(),
}));

const fixtureNode: LocalComputerSnapshot = {
  computerId: "computer-fixture",
  workspaceId: "workspace-fixture",
  agentId: "agent-fixture",
  locality: "local",
  backend: "cua-driver",
  isolation: "windows-session",
  lifecycle: "ready",
  controller: "agent",
  generation: 1,
  capabilities: ["persistent-files"],
  runtimeAvailable: true,
  retiredComputer: false,
  plugins: { computer: true },
  updatedAt: "2026-09-12T00:00:00Z",
  control: {
    status: "idle",
    requestId: null,
    generation: null,
    application: null,
    title: null,
    message: null,
  },
};
const fixtureComputer = () => ({
  refresh: vi.fn(async () => fixtureNode),
  prepareForTool: vi.fn(async () => fixtureNode),
  refreshFiles: vi.fn(async () => null),
});

describe("execution capability resolution (deterministic fixtures)", () => {
  it("awaits fresh computer capabilities even when the new worker has no uploads", async () => {
    const computer = fixtureComputer();
    const result = await prepareExecutionAttachments(
      [],
      computer,
      fixtureNode.workspaceId,
      fixtureNode.agentId,
      () => true,
    );
    expect(computer.refresh).toHaveBeenCalledOnce();
    expect(computerToolsReady(result.node)).toBe(true);
    expect(computer.prepareForTool).not.toHaveBeenCalled();
  });
  it.each(["stopped", "other-agent", "unavailable"])(
    "does not expose capabilities after %s",
    async (scenario) => {
      const computer = fixtureComputer();
      if (scenario === "other-agent")
        computer.refresh.mockResolvedValue({
          ...fixtureNode,
          agentId: "other",
        });
      if (scenario === "unavailable")
        computer.refresh.mockRejectedValue(new Error("Disconnected"));
      const result = await prepareExecutionAttachments(
        [],
        computer,
        fixtureNode.workspaceId,
        fixtureNode.agentId,
        () => scenario !== "stopped",
      );
      expect(result.node).toBeNull();
    },
  );
});

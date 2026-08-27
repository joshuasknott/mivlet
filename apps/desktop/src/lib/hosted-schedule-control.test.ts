import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@fable/protocol";
import { controlHostedScheduleWithApprovals } from "./hosted-schedule-control";

const approval: ApprovalRequest = {
  id: "approval-hosted-control-123",
  service: "Fable cloud computer",
  action: "Pause hosted schedule schedule-digest-123",
  mode: "full-access" as const,
  riskLevel: "critical" as const,
  dataUsed: ["schedule: schedule-digest-123"],
  consequence: "Stops future launches.",
  requestedAt: "2026-08-25T12:00:00.000Z",
  decisions: ["once", "deny"],
  confirmationPhrase: "change cloud schedule"
};

describe("controlHostedScheduleWithApprovals", () => {
  it("binds pause to fresh source and native approvals", async () => {
    const queueApproval = vi.fn();
    const waitForDecision = vi.fn(async () => "granted" as const);
    const prepare = vi.fn(async () => ({
      proposal: {
        requestKey: "schedule-control-12345678",
        workspaceId: "workspace-hosted",
        agentId: "agent-research",
        deviceId: "device-desktop",
        scheduleId: "schedule-digest-123",
        action: "pause" as const
      },
      proposalFingerprint: "fingerprint",
      approval
    }));
    const control = vi.fn(async () => ({
      scheduleId: "schedule-digest-123",
      requestKey: "schedule-request-123",
      runId: "weekly-digest",
      lifecycle: "paused" as const,
      firstRunAt: "2026-08-25T18:00:00.000Z",
      intervalSeconds: 3_600,
      generation: 1,
      updatedAt: "2026-08-25T12:00:00.000Z"
    }));
    const snapshot = await controlHostedScheduleWithApprovals({
      workspaceId: "workspace-hosted",
      agentId: "agent-research",
      deviceId: "device-desktop"
    }, "schedule-digest-123", "pause", {
      gate: { waitForDecision } as never,
      queueApproval,
      prepare,
      control,
      now: () => "2026-08-25T12:00:00.000Z"
    });
    expect(snapshot.lifecycle).toBe("paused");
    expect(queueApproval).toHaveBeenCalledTimes(2);
    expect(queueApproval.mock.calls[0]?.[0]).toMatchObject({ tool: "cloud-process-schedule-pause" });
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ action: "pause", scheduleId: "schedule-digest-123" }));
    expect(control).toHaveBeenCalledWith(
      expect.objectContaining({ action: "pause" }),
      expect.objectContaining({ decision: "once", confirmationText: "change cloud schedule" }),
      expect.objectContaining({ decision: "once", confirmationText: "approve cloud-process-schedule-pause" })
    );
  });

  it("fails closed before native preparation when source approval is denied", async () => {
    const prepare = vi.fn();
    await expect(controlHostedScheduleWithApprovals({
      workspaceId: "workspace-hosted",
      agentId: "agent-research",
      deviceId: "device-desktop"
    }, "schedule-digest-123", "resume", {
      gate: { waitForDecision: vi.fn(async () => "denied" as const) } as never,
      queueApproval: vi.fn(),
      prepare
    })).rejects.toThrow("resume was denied");
    expect(prepare).not.toHaveBeenCalled();
  });
});

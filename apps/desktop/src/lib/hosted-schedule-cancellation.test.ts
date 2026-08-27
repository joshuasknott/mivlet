import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, HostedProcessScheduleSnapshot } from "@fable/protocol";
import { cancelHostedScheduleWithApprovals } from "./hosted-schedule-cancellation";

const scope = {
  workspaceId: "workspace-hosted",
  agentId: "agent-research",
  deviceId: "device-desktop"
};

const nativeApproval: ApprovalRequest = {
  id: "approval-hosted-schedule-cancel-123",
  service: "Fable cloud computer",
  action: "Cancel always-on schedule schedule-digest-123",
  mode: "full-access",
  riskLevel: "critical",
  dataUsed: ["schedule: schedule-digest-123"],
  consequence: "Stops future runs.",
  requestedAt: "2026-08-25T18:00:00.000Z",
  decisions: ["once", "deny"],
  confirmationPhrase: "cancel cloud schedule"
};

const proposal = {
  requestKey: "schedule-cancel-12345678",
  ...scope,
  scheduleId: "schedule-digest-123"
};

const snapshot: HostedProcessScheduleSnapshot = {
  scheduleId: "schedule-digest-123",
  requestKey: "schedule-request-12345678",
  runId: "weekly-digest",
  lifecycle: "cancelled",
  firstRunAt: "2026-08-25T18:00:00.000Z",
  intervalSeconds: 3_600,
  generation: 1,
  updatedAt: "2026-08-25T18:01:00.000Z"
};

describe("cancelHostedScheduleWithApprovals", () => {
  it("binds a UI request and exact native proposal through two fresh approvals", async () => {
    const queueApproval = vi.fn();
    const gate = { waitForDecision: vi.fn(async () => "granted" as const) };
    const prepare = vi.fn(async () => ({
      proposal,
      proposalFingerprint: "fingerprint-123",
      approval: nativeApproval
    }));
    const cancel = vi.fn(async () => snapshot);

    await expect(cancelHostedScheduleWithApprovals(scope, proposal.scheduleId, {
      gate,
      queueApproval,
      prepare,
      cancel,
      now: () => "2026-08-25T18:00:30.000Z"
    })).resolves.toEqual(snapshot);

    expect(prepare).toHaveBeenCalledWith({ ...scope, scheduleId: proposal.scheduleId });
    expect(queueApproval).toHaveBeenCalledTimes(2);
    expect(queueApproval.mock.calls[0]?.[0]).toMatchObject({
      tool: "cloud-process-schedule-cancel",
      arguments: JSON.stringify({ scheduleId: proposal.scheduleId })
    });
    expect(queueApproval.mock.calls[1]?.[0].approval).toEqual(nativeApproval);
    expect(gate.waitForDecision).toHaveBeenNthCalledWith(2, nativeApproval);
    expect(cancel).toHaveBeenCalledWith(
      proposal,
      expect.objectContaining({
        request: nativeApproval,
        decision: "once",
        confirmationText: "cancel cloud schedule"
      }),
      expect.objectContaining({
        decision: "once",
        confirmationText: "approve cloud-process-schedule-cancel"
      })
    );
  });

  it("does not prepare or cancel when the first approval is denied", async () => {
    const prepare = vi.fn();
    const cancel = vi.fn();
    await expect(cancelHostedScheduleWithApprovals(scope, proposal.scheduleId, {
      gate: { waitForDecision: vi.fn(async () => "denied" as const) },
      queueApproval: vi.fn(),
      prepare,
      cancel
    })).rejects.toThrow(/denied/i);
    expect(prepare).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("does not cancel when the exact native proposal approval is denied", async () => {
    const cancel = vi.fn();
    const decisions: Array<"granted" | "denied"> = ["granted", "denied"];
    const gate = { waitForDecision: vi.fn(async () => decisions.shift() ?? "denied") };
    await expect(cancelHostedScheduleWithApprovals(scope, proposal.scheduleId, {
      gate,
      queueApproval: vi.fn(),
      prepare: vi.fn(async () => ({ proposal, proposalFingerprint: "fingerprint-123", approval: nativeApproval })),
      cancel
    })).rejects.toThrow(/denied/i);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("rejects malformed schedule ids before creating an approval", async () => {
    const queueApproval = vi.fn();
    await expect(cancelHostedScheduleWithApprovals(scope, "../schedule", {
      gate: { waitForDecision: vi.fn() },
      queueApproval
    })).rejects.toThrow(/cannot be cancelled/i);
    expect(queueApproval).not.toHaveBeenCalled();
  });
});

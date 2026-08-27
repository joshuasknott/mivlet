import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, HostedProcessScheduleSnapshot } from "@fable/protocol";
import {
  createHostedScheduleWithApprovals,
  hostedScheduleDraftFromForm
} from "./hosted-schedule-creation";

const scope = {
  workspaceId: "workspace-hosted",
  agentId: "agent-research",
  deviceId: "device-desktop"
};

const draft = hostedScheduleDraftFromForm(scope, {
  label: "Weekly digest",
  programPath: "scripts/digest.mjs",
  arguments: ["--week", "current"],
  firstRunAt: "2026-08-26T18:00:00.000Z",
  intervalSeconds: 86_400
}, () => "1234567890abcdef");

const nativeApproval: ApprovalRequest = {
  id: "approval-hosted-schedule-create-123",
  service: "Fable cloud computer",
  action: "Create always-on schedule",
  mode: "full-access",
  riskLevel: "critical",
  dataUsed: ["schedule: schedule-1234567890abcdef"],
  consequence: "Runs the displayed program on the displayed recurrence.",
  requestedAt: "2026-08-25T18:00:00.000Z",
  decisions: ["once", "deny"],
  confirmationPhrase: "schedule cloud process"
};

const proposal = { requestKey: "schedule-request-12345678", ...draft };
const snapshot: HostedProcessScheduleSnapshot = {
  scheduleId: draft.scheduleId,
  requestKey: proposal.requestKey,
  runId: draft.runId,
  lifecycle: "active",
  firstRunAt: draft.firstRunAt,
  intervalSeconds: draft.intervalSeconds,
  nextRunAt: draft.firstRunAt,
  generation: 1,
  updatedAt: "2026-08-25T18:01:00.000Z"
};

describe("hosted always-on schedule creation", () => {
  it("derives a confined explicit argv without shell parsing", () => {
    expect(draft).toMatchObject({
      scheduleId: "schedule-1234567890abcdef",
      runId: "scheduled-weekly-digest-12345678",
      argv: ["node", "/workspace/scripts/digest.mjs", "--week", "current"],
      cwd: "/workspace",
      timeoutMs: 900_000,
      intervalSeconds: 86_400
    });
  });

  it("rejects traversal, unsupported programs, and control-bearing arguments", () => {
    const base = {
      label: "Digest",
      programPath: "digest.py",
      arguments: [],
      firstRunAt: "2026-08-26T18:00:00.000Z",
      intervalSeconds: 3_600
    };
    expect(() => hostedScheduleDraftFromForm(scope, { ...base, programPath: "../secret.py" }, () => "12345678"))
      .toThrow(/below \/workspace/i);
    expect(() => hostedScheduleDraftFromForm(scope, { ...base, programPath: "digest.exe" }, () => "12345678"))
      .toThrow(/must be/i);
    expect(() => hostedScheduleDraftFromForm(scope, { ...base, arguments: ["bad\narg"] }, () => "12345678"))
      .toThrow(/visible/i);
  });

  it("uses the source tool approval and exact native proposal approval once each", async () => {
    const queueApproval = vi.fn();
    const gate = { waitForDecision: vi.fn(async () => "granted" as const) };
    const prepare = vi.fn(async () => ({ proposal, proposalFingerprint: "fingerprint", approval: nativeApproval }));
    const create = vi.fn(async () => snapshot);
    await expect(createHostedScheduleWithApprovals(draft, {
      gate,
      queueApproval,
      prepare,
      create,
      now: () => "2026-08-25T18:00:30.000Z"
    })).resolves.toEqual(snapshot);
    expect(prepare).toHaveBeenCalledWith(draft);
    expect(queueApproval).toHaveBeenCalledTimes(2);
    expect(queueApproval.mock.calls[0]?.[0]).toMatchObject({ tool: "cloud-process-schedule" });
    expect(gate.waitForDecision).toHaveBeenNthCalledWith(2, nativeApproval);
    expect(create).toHaveBeenCalledWith(
      proposal,
      expect.objectContaining({ request: nativeApproval, decision: "once" }),
      expect.objectContaining({ decision: "once", confirmationText: "approve cloud-process-schedule" })
    );
  });

  it("stops before the native proposal when the source request is denied", async () => {
    const prepare = vi.fn();
    await expect(createHostedScheduleWithApprovals(draft, {
      gate: { waitForDecision: vi.fn(async () => "denied" as const) },
      queueApproval: vi.fn(),
      prepare
    })).rejects.toThrow(/denied/i);
    expect(prepare).not.toHaveBeenCalled();
  });
});

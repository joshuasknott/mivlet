import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, HostedAgentRoutineSnapshot } from "@fable/protocol";
import {
  createHostedAgentRoutineWithApprovals,
  hostedAgentRoutineDraftFromForm
} from "./hosted-agent-routine";

const runtime = vi.hoisted(() => ({
  prepare: vi.fn(),
  create: vi.fn(),
  prepareCancel: vi.fn(),
  cancel: vi.fn(),
  prepareControl: vi.fn(),
  control: vi.fn()
}));

vi.mock("../runtime", () => ({
  prepareRuntimeHostedAgentRoutine: runtime.prepare,
  createRuntimeHostedAgentRoutine: runtime.create,
  prepareRuntimeHostedAgentRoutineCancel: runtime.prepareCancel,
  cancelRuntimeHostedAgentRoutine: runtime.cancel,
  prepareRuntimeHostedAgentRoutineControl: runtime.prepareControl,
  controlRuntimeHostedAgentRoutine: runtime.control
}));

describe("hosted agent routine form", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normalizes visible text, timing, identity, and ordered standing authority", () => {
    const draft = hostedAgentRoutineDraftFromForm(
      { workspaceId: "workspace-1", agentId: "agent-research", deviceId: "device-1" },
      {
        title: "  Weekly research digest  ",
        instruction: "  Read the workspace notes and update digest.md.  ",
        firstRunAt: "2026-08-26T18:30:00.000Z",
        intervalSeconds: 86_400,
        allowWorkspaceWrite: true,
        allowProcessRun: true,
        maxSteps: 7
      },
      () => "12345678abcdef"
    );

    expect(draft).toMatchObject({
      routineId: "routine-12345678abcdef",
      runId: "routine-weekly-research-digest-12345678",
      title: "Weekly research digest",
      instruction: "Read the workspace notes and update digest.md.",
      firstRunAt: "2026-08-26T18:30:00.000Z",
      intervalSeconds: 86_400,
      capabilities: ["workspace-read", "workspace-write", "process-run"],
      maxSteps: 7
    });
  });

  it("always grants read first and rejects unsafe timing or tool limits", () => {
    const scope = { workspaceId: "workspace-1", agentId: "agent-research", deviceId: "device-1" };
    expect(hostedAgentRoutineDraftFromForm(scope, {
      title: "Read-only review",
      instruction: "Review current workspace notes and summarize them.",
      firstRunAt: "2026-08-26T18:30:00.000Z",
      intervalSeconds: 300,
      allowWorkspaceWrite: false,
      allowProcessRun: false,
      maxSteps: 1
    }, () => "12345678abcdef").capabilities).toEqual(["workspace-read"]);

    expect(() => hostedAgentRoutineDraftFromForm(scope, {
      title: "Too frequent",
      instruction: "Review the workspace.",
      firstRunAt: "2026-08-26T18:30:00.000Z",
      intervalSeconds: 60,
      allowWorkspaceWrite: false,
      allowProcessRun: false,
      maxSteps: 1
    }, () => "12345678abcdef")).toThrow(/five minutes/i);
  });
});

describe("hosted agent routine approvals", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires both the model-facing action approval and exact native proposal approval", async () => {
    const draft = hostedAgentRoutineDraftFromForm(
      { workspaceId: "workspace-1", agentId: "agent-research", deviceId: "device-1" },
      {
        title: "Weekly research digest",
        instruction: "Read workspace notes and update digest.md.",
        firstRunAt: "2026-08-26T18:30:00.000Z",
        intervalSeconds: 86_400,
        allowWorkspaceWrite: true,
        allowProcessRun: false,
        maxSteps: 6
      },
      () => "12345678abcdef"
    );
    const hostedApproval: ApprovalRequest = {
      id: "approval-hosted-routine",
      service: "Fable cloud computer",
      action: "Create hosted routine Weekly research digest",
      mode: "full-access",
      riskLevel: "critical",
      dataUsed: ["standing capability: workspace-read", "standing capability: workspace-write"],
      consequence: "Runs the approved routine repeatedly.",
      requestedAt: "2026-08-26T16:00:00.000Z",
      decisions: ["once", "deny"],
      confirmationPhrase: "create cloud routine"
    };
    const proposal = { requestKey: "routine-request-a", ...draft };
    const snapshot: HostedAgentRoutineSnapshot = {
      ...proposal,
      maxSteps: draft.maxSteps ?? 6,
      lifecycle: "active",
      nextRunAt: draft.firstRunAt,
      generation: 1,
      updatedAt: "2026-08-26T16:00:01.000Z"
    };
    runtime.prepare.mockResolvedValue({
      proposal,
      proposalFingerprint: "routine-fingerprint-a",
      approval: hostedApproval
    });
    runtime.create.mockResolvedValue(snapshot);
    const queueApproval = vi.fn();
    const gate = { waitForDecision: vi.fn(async () => "granted" as const) };

    await expect(createHostedAgentRoutineWithApprovals(draft, {
      gate,
      queueApproval,
      now: () => "2026-08-26T16:00:02.000Z"
    })).resolves.toEqual(snapshot);

    expect(gate.waitForDecision).toHaveBeenCalledTimes(2);
    const sourceApproval = (gate.waitForDecision.mock.calls as unknown[][])[0]?.[0] as ApprovalRequest;
    expect(sourceApproval).toMatchObject({
      service: "fable-ui",
      riskLevel: "critical",
      confirmationPhrase: "approve cloud-agent-routine"
    });
    expect(gate.waitForDecision).toHaveBeenNthCalledWith(2, hostedApproval);
    expect(runtime.create).toHaveBeenCalledWith(
      proposal,
      expect.objectContaining({ request: hostedApproval, decision: "once" }),
      expect.objectContaining({ request: sourceApproval, decision: "once" })
    );
    expect(queueApproval).toHaveBeenCalledTimes(2);
  });
});

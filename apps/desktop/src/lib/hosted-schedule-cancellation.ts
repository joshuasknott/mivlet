import { buildToolApproval } from "@fable/connectors/native-api/approvals";
import type { ApprovalRequest, ApprovalResolutionRequest, HostedProcessScheduleSnapshot } from "@fable/protocol";
import type { ApprovalGate } from "@fable/connectors/native-api/tool-executor";
import {
  cancelRuntimeHostedProcessSchedule,
  prepareRuntimeHostedProcessScheduleCancel
} from "../runtime";

export interface HostedScheduleCancellationScope {
  workspaceId: string;
  agentId: string;
  deviceId: string;
}

interface HostedScheduleCancellationDependencies {
  gate: ApprovalGate;
  queueApproval: (event: {
    callId: string;
    tool: string;
    arguments: string;
    approval: ApprovalRequest;
  }) => void;
  prepare?: typeof prepareRuntimeHostedProcessScheduleCancel;
  cancel?: typeof cancelRuntimeHostedProcessSchedule;
  now?: () => string;
}

/**
 * Human-initiated cancellation uses the same two immutable approval envelopes
 * as a model-originated cancellation: one for the requested tool effect and
 * one for the exact native proposal. Neither approval can be silently reused.
 */
export async function cancelHostedScheduleWithApprovals(
  scope: HostedScheduleCancellationScope,
  scheduleId: string,
  dependencies: HostedScheduleCancellationDependencies
): Promise<HostedProcessScheduleSnapshot> {
  if (
    !scope.workspaceId
    || !scope.agentId
    || !scope.deviceId
    || !/^schedule-[A-Za-z0-9_-]{8,120}$/u.test(scheduleId)
  ) {
    throw new Error("This always-on schedule cannot be cancelled from the current cloud computer.");
  }
  const prepare = dependencies.prepare ?? prepareRuntimeHostedProcessScheduleCancel;
  const cancel = dependencies.cancel ?? cancelRuntimeHostedProcessSchedule;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const argumentsJson = JSON.stringify({ scheduleId });
  const sourceApproval = buildToolApproval(
    "fable-ui",
    "cloud-process-schedule-cancel",
    argumentsJson
  );
  dependencies.queueApproval({
    callId: sourceApproval.id,
    tool: "cloud-process-schedule-cancel",
    arguments: argumentsJson,
    approval: sourceApproval
  });
  if (await dependencies.gate.waitForDecision(sourceApproval) !== "granted") {
    throw new Error("Always-on schedule cancellation was denied.");
  }
  const sourceResolution: ApprovalResolutionRequest = {
    request: sourceApproval,
    decision: "once",
    decidedAt: now(),
    confirmationText: sourceApproval.confirmationPhrase
  };
  const prepared = await prepare({ ...scope, scheduleId });
  if (!prepared) throw new Error("Always-on schedule cancellation requires the desktop runtime.");
  dependencies.queueApproval({
    callId: prepared.approval.id,
    tool: "cloud-process-schedule-cancel",
    arguments: argumentsJson,
    approval: prepared.approval
  });
  if (await dependencies.gate.waitForDecision(prepared.approval) !== "granted") {
    throw new Error("Always-on schedule cancellation was denied.");
  }
  const resolution: ApprovalResolutionRequest = {
    request: prepared.approval,
    decision: "once",
    decidedAt: now(),
    confirmationText: prepared.approval.confirmationPhrase
  };
  const snapshot = await cancel(prepared.proposal, resolution, sourceResolution);
  if (!snapshot) throw new Error("Always-on schedule cancellation requires the desktop runtime.");
  return snapshot;
}

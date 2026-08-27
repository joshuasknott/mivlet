import { buildToolApproval } from "@fable/connectors/native-api/approvals";
import type { ApprovalRequest, ApprovalResolutionRequest, HostedProcessScheduleControlAction, HostedProcessScheduleSnapshot } from "@fable/protocol";
import type { ApprovalGate } from "@fable/connectors/native-api/tool-executor";
import { controlRuntimeHostedProcessSchedule, prepareRuntimeHostedProcessScheduleControl } from "../runtime";

export interface HostedScheduleControlScope {
  workspaceId: string;
  agentId: string;
  deviceId: string;
}

interface HostedScheduleControlDependencies {
  gate: ApprovalGate;
  queueApproval: (event: { callId: string; tool: string; arguments: string; approval: ApprovalRequest }) => void;
  prepare?: typeof prepareRuntimeHostedProcessScheduleControl;
  control?: typeof controlRuntimeHostedProcessSchedule;
  now?: () => string;
}

export async function controlHostedScheduleWithApprovals(
  scope: HostedScheduleControlScope,
  scheduleId: string,
  action: HostedProcessScheduleControlAction,
  dependencies: HostedScheduleControlDependencies
): Promise<HostedProcessScheduleSnapshot> {
  if (!scope.workspaceId || !scope.agentId || !scope.deviceId
    || !/^schedule-[A-Za-z0-9_-]{8,120}$/u.test(scheduleId)
    || (action !== "pause" && action !== "resume")) {
    throw new Error("This always-on schedule cannot be changed from the current cloud computer.");
  }
  const tool = `cloud-process-schedule-${action}`;
  const argumentsJson = JSON.stringify({ scheduleId });
  const sourceApproval = buildToolApproval("fable-ui", tool, argumentsJson);
  dependencies.queueApproval({ callId: sourceApproval.id, tool, arguments: argumentsJson, approval: sourceApproval });
  if (await dependencies.gate.waitForDecision(sourceApproval) !== "granted") {
    throw new Error(`Always-on schedule ${action} was denied.`);
  }
  const now = dependencies.now ?? (() => new Date().toISOString());
  const sourceResolution: ApprovalResolutionRequest = {
    request: sourceApproval,
    decision: "once",
    decidedAt: now(),
    confirmationText: sourceApproval.confirmationPhrase
  };
  const prepared = await (dependencies.prepare ?? prepareRuntimeHostedProcessScheduleControl)({ ...scope, scheduleId, action });
  if (!prepared) throw new Error(`Always-on schedule ${action} requires the desktop runtime.`);
  dependencies.queueApproval({ callId: prepared.approval.id, tool, arguments: argumentsJson, approval: prepared.approval });
  if (await dependencies.gate.waitForDecision(prepared.approval) !== "granted") {
    throw new Error(`Always-on schedule ${action} was denied.`);
  }
  const resolution: ApprovalResolutionRequest = {
    request: prepared.approval,
    decision: "once",
    decidedAt: now(),
    confirmationText: prepared.approval.confirmationPhrase
  };
  const snapshot = await (dependencies.control ?? controlRuntimeHostedProcessSchedule)(prepared.proposal, resolution, sourceResolution);
  if (!snapshot) throw new Error(`Always-on schedule ${action} requires the desktop runtime.`);
  return snapshot;
}

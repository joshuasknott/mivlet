import { buildToolApproval } from "@fable/connectors/native-api/approvals";
import type { ApprovalGate } from "@fable/connectors/native-api/tool-executor";
import type {
  ApprovalRequest,
  ApprovalResolutionRequest,
  HostedAgentRoutineCapability,
  HostedAgentRoutineControlAction,
  HostedAgentRoutineDraft,
  HostedAgentRoutineSnapshot
} from "@fable/protocol";
import {
  cancelRuntimeHostedAgentRoutine,
  controlRuntimeHostedAgentRoutine,
  createRuntimeHostedAgentRoutine,
  prepareRuntimeHostedAgentRoutine,
  prepareRuntimeHostedAgentRoutineCancel,
  prepareRuntimeHostedAgentRoutineControl
} from "../runtime";

export interface HostedAgentRoutineScope {
  workspaceId: string;
  agentId: string;
  deviceId: string;
}

export interface HostedAgentRoutineFormInput {
  title: string;
  instruction: string;
  firstRunAt: string;
  intervalSeconds: number;
  allowWorkspaceWrite: boolean;
  allowProcessRun: boolean;
  maxSteps: number;
}

interface ApprovalDependencies {
  gate: ApprovalGate;
  queueApproval: (event: { callId: string; tool: string; arguments: string; approval: ApprovalRequest }) => void;
  now?: () => string;
}

export function hostedAgentRoutineDraftFromForm(
  scope: HostedAgentRoutineScope,
  input: HostedAgentRoutineFormInput,
  id: () => string = () => crypto.randomUUID().replace(/-/gu, "")
): HostedAgentRoutineDraft {
  const title = input.title.trim();
  const instruction = input.instruction.trim();
  const firstRun = new Date(input.firstRunAt);
  if (!title || title.length > 120 || /[\u0000-\u001f\u007f]/u.test(title)) {
    throw new Error("Add a short visible routine name.");
  }
  if (!instruction || instruction.length > 12_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(instruction)) {
    throw new Error("Describe the background outcome in 12,000 characters or fewer.");
  }
  if (!Number.isFinite(firstRun.getTime())) throw new Error("Choose a valid first run time.");
  if (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds < 300 || input.intervalSeconds > 604_800) {
    throw new Error("Choose a repeat interval between five minutes and seven days.");
  }
  if (!Number.isInteger(input.maxSteps) || input.maxSteps < 1 || input.maxSteps > 8) {
    throw new Error("Choose between one and eight tool steps per run.");
  }
  const token = id().replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 40);
  if (token.length < 8) throw new Error("Fable could not create a safe routine identity.");
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 48) || "background-work";
  const capabilities: HostedAgentRoutineCapability[] = ["workspace-read"];
  if (input.allowWorkspaceWrite) capabilities.push("workspace-write");
  if (input.allowProcessRun) capabilities.push("process-run");
  return {
    ...scope,
    routineId: `routine-${token}`,
    runId: `routine-${slug}-${token.slice(0, 8)}`,
    title,
    instruction,
    firstRunAt: firstRun.toISOString(),
    intervalSeconds: input.intervalSeconds,
    capabilities,
    maxSteps: input.maxSteps
  };
}

export async function createHostedAgentRoutineWithApprovals(
  draft: HostedAgentRoutineDraft,
  dependencies: ApprovalDependencies
): Promise<HostedAgentRoutineSnapshot> {
  const tool = "cloud-agent-routine";
  const argumentsJson = JSON.stringify({
    routineId: draft.routineId,
    runId: draft.runId,
    title: draft.title,
    instruction: draft.instruction,
    firstRunAt: draft.firstRunAt,
    intervalSeconds: draft.intervalSeconds,
    capabilities: draft.capabilities,
    maxSteps: draft.maxSteps ?? 6
  });
  const sourceResolution = await approveSource(tool, argumentsJson, "Cloud routine creation", dependencies);
  const prepared = await prepareRuntimeHostedAgentRoutine(draft);
  if (!prepared) throw new Error("Cloud routine creation requires the desktop runtime.");
  const resolution = await approvePrepared(tool, argumentsJson, prepared.approval, "Cloud routine creation", dependencies);
  const snapshot = await createRuntimeHostedAgentRoutine(prepared.proposal, resolution, sourceResolution);
  if (!snapshot) throw new Error("Cloud routine creation requires the desktop runtime.");
  return snapshot;
}

export async function cancelHostedAgentRoutineWithApprovals(
  scope: HostedAgentRoutineScope,
  routineId: string,
  dependencies: ApprovalDependencies
): Promise<HostedAgentRoutineSnapshot> {
  validateTarget(scope, routineId);
  const tool = "cloud-agent-routine-cancel";
  const argumentsJson = JSON.stringify({ routineId });
  const sourceResolution = await approveSource(tool, argumentsJson, "Cloud routine cancellation", dependencies);
  const prepared = await prepareRuntimeHostedAgentRoutineCancel({ ...scope, routineId });
  if (!prepared) throw new Error("Cloud routine cancellation requires the desktop runtime.");
  const resolution = await approvePrepared(tool, argumentsJson, prepared.approval, "Cloud routine cancellation", dependencies);
  const snapshot = await cancelRuntimeHostedAgentRoutine(prepared.proposal, resolution, sourceResolution);
  if (!snapshot) throw new Error("Cloud routine cancellation requires the desktop runtime.");
  return snapshot;
}

export async function controlHostedAgentRoutineWithApprovals(
  scope: HostedAgentRoutineScope,
  routineId: string,
  action: HostedAgentRoutineControlAction,
  dependencies: ApprovalDependencies
): Promise<HostedAgentRoutineSnapshot> {
  validateTarget(scope, routineId);
  if (action !== "pause" && action !== "resume") throw new Error("That cloud routine change is invalid.");
  const tool = `cloud-agent-routine-${action}`;
  const argumentsJson = JSON.stringify({ routineId });
  const label = `Cloud routine ${action}`;
  const sourceResolution = await approveSource(tool, argumentsJson, label, dependencies);
  const prepared = await prepareRuntimeHostedAgentRoutineControl({ ...scope, routineId, action });
  if (!prepared) throw new Error(`${label} requires the desktop runtime.`);
  const resolution = await approvePrepared(tool, argumentsJson, prepared.approval, label, dependencies);
  const snapshot = await controlRuntimeHostedAgentRoutine(prepared.proposal, resolution, sourceResolution);
  if (!snapshot) throw new Error(`${label} requires the desktop runtime.`);
  return snapshot;
}

async function approveSource(
  tool: string,
  argumentsJson: string,
  label: string,
  dependencies: ApprovalDependencies
): Promise<ApprovalResolutionRequest> {
  const approval = buildToolApproval("fable-ui", tool, argumentsJson);
  dependencies.queueApproval({ callId: approval.id, tool, arguments: argumentsJson, approval });
  if (await dependencies.gate.waitForDecision(approval) !== "granted") throw new Error(`${label} was denied.`);
  return resolutionFor(approval, dependencies.now);
}

async function approvePrepared(
  tool: string,
  argumentsJson: string,
  approval: ApprovalRequest,
  label: string,
  dependencies: ApprovalDependencies
): Promise<ApprovalResolutionRequest> {
  dependencies.queueApproval({ callId: approval.id, tool, arguments: argumentsJson, approval });
  if (await dependencies.gate.waitForDecision(approval) !== "granted") throw new Error(`${label} was denied.`);
  return resolutionFor(approval, dependencies.now);
}

function resolutionFor(approval: ApprovalRequest, now?: () => string): ApprovalResolutionRequest {
  return {
    request: approval,
    decision: "once",
    decidedAt: (now ?? (() => new Date().toISOString()))(),
    confirmationText: approval.confirmationPhrase
  };
}

function validateTarget(scope: HostedAgentRoutineScope, routineId: string): void {
  if (!scope.workspaceId || !scope.agentId || !scope.deviceId || !/^routine-[A-Za-z0-9_-]{8,120}$/u.test(routineId)) {
    throw new Error("This cloud routine is not available from the current computer.");
  }
}

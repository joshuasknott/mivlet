/**
 * Provider-neutral records for natural-language work that runs on a Fable
 * hosted computer while every client device is offline.
 *
 * Model/provider credentials never cross this contract. The hosted execution
 * node resolves its managed model binding inside the cloud trust boundary.
 */

import type { ApprovalRequest } from "./approvals.js";
import type { HostedScheduleLifecycle } from "./hosted-computer.js";

export const HOSTED_AGENT_ROUTINE_CAPABILITIES = [
  "workspace-read",
  "workspace-write",
  "process-run"
] as const;

export type HostedAgentRoutineCapability =
  (typeof HOSTED_AGENT_ROUTINE_CAPABILITIES)[number];

export type HostedAgentRoutineRunLifecycle =
  | "running"
  | "completed"
  | "failed"
  | "stale";

export interface HostedAgentRoutineDraft {
  workspaceId: string;
  agentId: string;
  deviceId: string;
  routineId: string;
  runId: string;
  title: string;
  instruction: string;
  firstRunAt: string;
  intervalSeconds: number;
  capabilities: readonly HostedAgentRoutineCapability[];
  maxSteps?: number;
}

export interface HostedAgentRoutineProposal extends HostedAgentRoutineDraft {
  requestKey: string;
}

export interface PreparedHostedAgentRoutine {
  proposal: HostedAgentRoutineProposal;
  proposalFingerprint: string;
  approval: ApprovalRequest;
}

/** Runner-facing request. Identity scope is bound by the signed capability. */
export interface HostedAgentRoutineRequest {
  requestKey: string;
  routineId: string;
  runId: string;
  title: string;
  instruction: string;
  firstRunAt: string;
  intervalSeconds: number;
  capabilities: readonly HostedAgentRoutineCapability[];
  maxSteps: number;
}

export interface HostedAgentRoutineTarget {
  workspaceId: string;
  agentId: string;
  deviceId: string;
  routineId: string;
}

export interface HostedAgentRoutineListTarget {
  workspaceId: string;
  agentId: string;
  deviceId: string;
}

export type HostedAgentRoutineControlAction = "pause" | "resume";

export interface HostedAgentRoutineControlDraft
  extends HostedAgentRoutineTarget {
  action: HostedAgentRoutineControlAction;
}

export interface HostedAgentRoutineControlProposal
  extends HostedAgentRoutineControlDraft {
  requestKey: string;
}

export interface PreparedHostedAgentRoutineControl {
  proposal: HostedAgentRoutineControlProposal;
  proposalFingerprint: string;
  approval: ApprovalRequest;
}

export interface HostedAgentRoutineCancelProposal
  extends HostedAgentRoutineTarget {
  requestKey: string;
}

export interface PreparedHostedAgentRoutineCancel {
  proposal: HostedAgentRoutineCancelProposal;
  proposalFingerprint: string;
  approval: ApprovalRequest;
}

export interface HostedAgentRoutineSnapshot {
  routineId: string;
  requestKey: string;
  runId: string;
  title: string;
  instruction: string;
  lifecycle: HostedScheduleLifecycle;
  firstRunAt: string;
  intervalSeconds: number;
  capabilities: readonly HostedAgentRoutineCapability[];
  maxSteps: number;
  nextRunAt?: string;
  lastRunAt?: string;
  lastRunId?: string;
  lastRunLifecycle?: HostedAgentRoutineRunLifecycle;
  lastResult?: string;
  lastErrorCode?: string;
  generation: number;
  updatedAt: string;
}

export interface HostedAgentRoutineToolRunSnapshot {
  tool: "workspace-list" | "workspace-read" | "workspace-write" | "process-run";
  summary: string;
  status: "completed" | "failed";
}

/** Bounded result evidence for one routine occurrence. */
export interface HostedAgentRoutineRunSnapshot {
  occurrenceId: string;
  routineId: string;
  runId: string;
  scheduledAt: string;
  lifecycle: HostedAgentRoutineRunLifecycle;
  result?: string;
  errorCode?: string;
  tools: readonly HostedAgentRoutineToolRunSnapshot[];
  startedAt: string;
  endedAt?: string;
  generation: number;
  updatedAt: string;
}

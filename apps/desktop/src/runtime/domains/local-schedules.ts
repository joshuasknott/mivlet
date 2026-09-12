import { getRuntimeAdapter } from "../adapters/select";
import { toRuntimeError } from "../errors";

export type LocalScheduleTrigger =
  | { kind: "once"; localDateTime: string }
  | { kind: "daily"; localTime: string }
  | { kind: "weekly"; weekday: string; localTime: string };
export type LocalScheduleStatus = "enabled" | "paused" | "cancelled";
export interface LocalScheduleInput {
  workspaceId: string;
  id: string;
  projectId?: string;
  agentId: string;
  providerId: string;
  model: string;
  reasoningEffort?: string;
  prompt: string;
  timezone: string;
  trigger: LocalScheduleTrigger;
}
export interface LocalSchedule extends Omit<LocalScheduleInput, "workspaceId"> {
  status: LocalScheduleStatus;
  revision: number;
  promptRevision: number;
  nextRunAt?: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface LocalScheduleOccurrence {
  id: string;
  scheduleId: string;
  scheduleRevision: number;
  promptRevision: number;
  state: "claimed" | "running" | "completed" | "failed" | "interrupted";
  executionAttemptId?: string;
  threadId?: string;
  scheduledFor: string;
  claimedAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  outcome?: string;
  detail?: string;
}

export interface LocalScheduleDispatchClaim {
  projectId?: string;
  occurrenceId: string;
  scheduleId: string;
  scheduleRevision: number;
  promptRevision: number;
  scheduledFor: string;
  claimToken: string;
  leaseExpiresAt: string;
  agentId: string;
  providerId: string;
  model: string;
  reasoningEffort?: string;
  prompt: string;
}

async function invoke<T>(command: string, request: object): Promise<T> {
  const adapter = getRuntimeAdapter();
  if (adapter.kind === "preview")
    throw new Error("Schedules require the installed desktop app.");
  try {
    return await adapter.invoke<T>(command, { request });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export const listLocalSchedules = (workspaceId: string) =>
  invoke<LocalSchedule[]>("local_schedule_list", { workspaceId });
export const previewLocalSchedule = (request: {
  timezone: string;
  trigger: LocalScheduleTrigger;
}) => invoke<string | null>("local_schedule_preview", request);
export const createLocalSchedule = (
  request: LocalScheduleInput & { status: "enabled" | "paused" },
) => invoke<LocalSchedule>("local_schedule_create", request);
export const updateLocalSchedule = (
  request: LocalScheduleInput & { expectedRevision: number },
) => invoke<LocalSchedule>("local_schedule_update", request);
export const setLocalScheduleStatus = (request: {
  workspaceId: string;
  id: string;
  expectedRevision: number;
  status: LocalScheduleStatus;
}) => invoke<LocalSchedule>("local_schedule_set_status", request);
export const listLocalScheduleOccurrences = (
  workspaceId: string,
  scheduleId: string,
  limit = 5,
) =>
  invoke<LocalScheduleOccurrence[]>("local_schedule_occurrence_list", {
    workspaceId,
    scheduleId,
    limit,
  });

/** Main-window orchestration seams. These are intentionally not exported from
 * the public runtime barrel or registered as model tools. */
export const claimLocalScheduleDispatch = (request: {
  workspaceId: string;
  expectedScheduleId: string;
  expectedRevision: number;
}) =>
  invoke<LocalScheduleDispatchClaim | null>(
    "local_schedule_dispatch_claim",
    request,
  );

export const bindLocalScheduleDispatch = (request: {
  workspaceId: string;
  occurrenceId: string;
  claimToken: string;
  attemptId: string;
}) => invoke<string>("local_schedule_dispatch_bind", request);

export const renewLocalScheduleDispatch = (request: {
  workspaceId: string;
  occurrenceId: string;
  claimToken: string;
  attemptId: string;
}) => invoke<string>("local_schedule_dispatch_renew", request);

export const finishLocalScheduleDispatch = (request: {
  workspaceId: string;
  occurrenceId: string;
  claimToken: string;
  attemptId: string;
  outcome: "completed" | "failed" | "interrupted";
  detail?: string;
}) => invoke<void>("local_schedule_dispatch_finish", request);

export const abandonLocalScheduleDispatch = (request: {
  workspaceId: string;
  occurrenceId: string;
  claimToken: string;
  detail: string;
}) => invoke<void>("local_schedule_dispatch_abandon", request);

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { BackendProvider, FableAgentProfile } from "@fable/protocol";
import {
  abandonLocalScheduleDispatch,
  bindLocalScheduleDispatch,
  claimLocalScheduleDispatch,
  finishLocalScheduleDispatch,
  listLocalSchedules,
  renewLocalScheduleDispatch,
  type LocalSchedule,
} from "../runtime/domains/local-schedules";
import { AgentRunService } from "../lib/agent-run-service";

export type LocalScheduleDispatchPhase =
  "idle" | "claiming" | "running" | "needs-user" | "failed";

export interface LocalScheduleDispatchStatus {
  phase: LocalScheduleDispatchPhase;
  scheduleId?: string;
  occurrenceId?: string;
  threadId?: string;
  message?: string;
  updatedAt: string;
}

export interface UseLocalScheduleDispatcherOptions {
  workspaceId?: string;
  agents: FableAgentProfile[];
  providers: BackendProvider[];
  runtimeReady: boolean;
  onThreadCreated?: (agentId: string, threadId: string) => void;
}

const listeners = new Set<() => void>();
let snapshot: LocalScheduleDispatchStatus = {
  phase: "idle",
  updatedAt: new Date(0).toISOString(),
};
const service = new AgentRunService();

function publish(next: Omit<LocalScheduleDispatchStatus, "updatedAt">) {
  snapshot = { ...next, updatedAt: new Date().toISOString() };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLocalScheduleDispatchStatus() {
  return snapshot;
}

export function useLocalScheduleDispatchStatus() {
  return useSyncExternalStore(
    subscribe,
    getLocalScheduleDispatchStatus,
    getLocalScheduleDispatchStatus,
  );
}

function firstDue(schedules: LocalSchedule[], now = Date.now()) {
  return schedules
    .filter(
      (schedule) =>
        schedule.status === "enabled" &&
        Boolean(schedule.nextRunAt) &&
        Number.isFinite(Date.parse(schedule.nextRunAt!)) &&
        Date.parse(schedule.nextRunAt!) <= now,
    )
    .sort((left, right) =>
      left.nextRunAt === right.nextRunAt
        ? left.id.localeCompare(right.id)
        : Date.parse(left.nextRunAt!) - Date.parse(right.nextRunAt!),
    )[0];
}

/**
 * Mount once with the shell runtime. The dispatcher is independent of the
 * selected conversation and uses a Rust-owned serial capacity slot. Its route
 * is deliberately limited to Codex provider-owned web research with no Mivlet
 * tools, Computer access, connector access, or standing approvals.
 */
export function useLocalScheduleDispatcher(
  options: UseLocalScheduleDispatcherOptions,
) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(() => {
    let disposed = false;
    let polling = false;
    let activeCancel: (() => Promise<void>) | undefined;
    publish({ phase: "idle" });

    const tick = async () => {
      const currentOptions = optionsRef.current;
      if (
        disposed ||
        polling ||
        !currentOptions.runtimeReady ||
        !currentOptions.workspaceId
      )
        return;
      const workspaceId = currentOptions.workspaceId;
      const isCurrent = () =>
        !disposed &&
        optionsRef.current.runtimeReady &&
        optionsRef.current.workspaceId === workspaceId;
      polling = true;
      let claim: Awaited<ReturnType<typeof claimLocalScheduleDispatch>> | null =
        null;
      let bound = false;
      let leaseTimer: ReturnType<typeof setInterval> | undefined;
      let statusTimer: ReturnType<typeof setInterval> | undefined;
      try {
        const schedules = await listLocalSchedules(workspaceId);
        if (!isCurrent()) return;
        const due = firstDue(schedules);
        if (!due) return;
        const agent = currentOptions.agents.find(
          (candidate) => candidate.id === due.agentId,
        );
        if (!agent) {
          publish({
            phase: "failed",
            scheduleId: due.id,
            message:
              "Scheduled research is waiting for its named agent to be available.",
          });
          return;
        }
        const provider = currentOptions.providers.find(
          (candidate) => candidate.id === due.providerId,
        );
        if (
          !provider ||
          provider.backendType !== "codex-app-server" ||
          provider.authState !== "connected"
        ) {
          publish({
            phase: "failed",
            scheduleId: due.id,
            message:
              "Scheduled research currently supports its original connected Codex provider only.",
          });
          return;
        }
        const modelDefinition = provider.models.find(
          (candidate) => candidate.id === due.model,
        );
        if (
          !modelDefinition?.available ||
          modelDefinition.capabilities?.streaming === false
        ) {
          publish({
            phase: "failed",
            scheduleId: due.id,
            message:
              "Scheduled research is waiting for its original Codex model to be available.",
          });
          return;
        }

        publish({ phase: "claiming", scheduleId: due.id });
        claim = await claimLocalScheduleDispatch({
          workspaceId,
          expectedScheduleId: due.id,
          expectedRevision: due.revision,
        });
        if (!isCurrent()) return;
        if (!claim) return;
        const immutableOccurrenceId = claim.occurrenceId;
        const immutableAttemptId = `schedule-run-${immutableOccurrenceId}`;
        const identity = {
          workspaceId,
          occurrenceId: immutableOccurrenceId,
          claimToken: claim.claimToken,
          attemptId: immutableAttemptId,
        };
        const result = await service.runScheduledResearch({
          attemptId: immutableAttemptId,
          workspaceId,
          scheduleId: claim.scheduleId,
          occurrenceId: immutableOccurrenceId,
          prompt: claim.prompt,
          providerId: claim.providerId,
          model: claim.model,
          agent,
          provider,
          modelDefinition,
          isCurrent,
          onThreadCreated: (threadId) => {
            if (isCurrent())
              currentOptions.onThreadCreated?.(agent.id, threadId);
          },
          onQueued: async () => {
            await bindLocalScheduleDispatch(identity);
            bound = true;
            leaseTimer = setInterval(() => {
              void renewLocalScheduleDispatch(identity).catch(() =>
                activeCancel?.(),
              );
            }, 60_000);
            statusTimer = setInterval(() => {
              void listLocalSchedules(workspaceId)
                .then((latest) => {
                  const current = latest.find(
                    (schedule) => schedule.id === claim?.scheduleId,
                  );
                  if (current && current.status !== "enabled")
                    void activeCancel?.();
                })
                .catch(() => undefined);
            }, 5_000);
          },
          onBackendReady: (cancel) => {
            activeCancel = cancel;
          },
          onProgress: ({ threadId, activity }) => {
            publish({
              phase: "running",
              scheduleId: claim!.scheduleId,
              occurrenceId: immutableOccurrenceId,
              threadId,
              ...(activity ? { message: activity } : {}),
            });
          },
        });
        if (!isCurrent()) return;
        const occurrenceOutcome =
          result.terminal === "completed"
            ? "completed"
            : result.terminal === "failed"
              ? "failed"
              : "interrupted";
        await finishLocalScheduleDispatch({
          ...identity,
          outcome: occurrenceOutcome,
          ...(result.message ? { detail: result.message } : {}),
        });
        if (!isCurrent()) return;
        publish({
          phase:
            result.terminal === "needs-user"
              ? "needs-user"
              : result.terminal === "completed"
                ? "idle"
                : "failed",
          scheduleId: claim.scheduleId,
          occurrenceId: immutableOccurrenceId,
          threadId: result.threadId,
          ...(result.message ? { message: result.message } : {}),
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Scheduled research could not run.";
        if (claim && !bound) {
          await abandonLocalScheduleDispatch({
            workspaceId,
            occurrenceId: claim.occurrenceId,
            claimToken: claim.claimToken,
            detail: message,
          }).catch(() => undefined);
        }
        if (!isCurrent()) return;
        publish({
          phase: "failed",
          ...(claim
            ? { scheduleId: claim.scheduleId, occurrenceId: claim.occurrenceId }
            : {}),
          message,
        });
      } finally {
        if (leaseTimer) clearInterval(leaseTimer);
        if (statusTimer) clearInterval(statusTimer);
        activeCancel = undefined;
        polling = false;
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), 15_000);
    return () => {
      disposed = true;
      clearInterval(timer);
      void activeCancel?.();
    };
  }, [options.runtimeReady, options.workspaceId]);
}

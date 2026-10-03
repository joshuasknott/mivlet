import { useEffect, useRef, useSyncExternalStore } from "react";
import { supportsSharedComputerTools } from "@mivlet/connectors/native-api/computer-vision";
import type { ScheduledWorkResult } from "../lib/workspace-execution";
import type { BackendProvider, MivletAgentProfile } from "@mivlet/protocol";
import {
  abandonLocalScheduleDispatch,
  bindLocalScheduleDispatch,
  claimLocalScheduleDispatch,
  finishLocalScheduleDispatch,
  listLocalSchedules,
  renewLocalScheduleDispatch,
  stageLocalScheduleDispatch,
  type LocalSchedule,
} from "../runtime/domains/local-schedules";
import { AgentRunService } from "../lib/agent-run-service";

type LocalScheduleDispatchPhase =
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
  agents: MivletAgentProfile[];
  providers: BackendProvider[];
  runtimeReady: boolean;
  onThreadCreated?: (agentId: string, threadId: string) => void;
  canStart?: (agentId: string, providerId: string) => boolean;
  projectContext?: (projectId: string, prompt: string) => Promise<string>;
  onBound?: (
    attemptId: string,
    cancel: () => Promise<void>,
  ) => Promise<() => void>;
  onFinished?: () => Promise<void>;
  runWork?: (input: {
    workId: string;
    threadId: string;
    onQueued: (attemptId: string) => Promise<void>;
    onReady: (cancel: () => Promise<void>) => void;
  }) => Promise<ScheduledWorkResult>;
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

function getLocalScheduleDispatchStatus() {
  return snapshot;
}

export function useLocalScheduleDispatchStatus() {
  return useSyncExternalStore(
    subscribe,
    getLocalScheduleDispatchStatus,
    getLocalScheduleDispatchStatus,
  );
}

function firstDue(
  schedules: LocalSchedule[],
  now = Date.now(),
  eligible = (_schedule: LocalSchedule) => true,
) {
  return schedules
    .filter(
      (schedule) =>
        schedule.status === "enabled" &&
        eligible(schedule) &&
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
 * dispatches claimed automations through ordinary Work. Legacy research-only
 * schedules retain their restricted Codex runner.
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
      let stopped = false;
      let finalized = false;
      let runCancel: (() => Promise<void>) | undefined;
      let cancelRequested = false;
      const cancelRun = () => {
        cancelRequested = true;
        return runCancel?.() ?? Promise.resolve();
      };
      const isCurrent = () =>
        !disposed &&
        !stopped &&
        !finalized &&
        optionsRef.current.runtimeReady &&
        optionsRef.current.workspaceId === workspaceId;
      activeCancel = cancelRun;
      polling = true;
      let claim: Awaited<ReturnType<typeof claimLocalScheduleDispatch>> | null =
        null;
      let bound = false;
      let leaseTimer: ReturnType<typeof setInterval> | undefined;
      let statusTimer: ReturnType<typeof setInterval> | undefined;
      let release: (() => void) | undefined;
      try {
        const schedules = await listLocalSchedules(workspaceId);
        if (!isCurrent()) return;
        const due =
          firstDue(schedules, Date.now(), (schedule) => {
            const provider = currentOptions.providers.find(
              (provider) => provider.id === schedule.providerId,
            );
            const model = provider?.models.find(
              (model) => model.id === schedule.model,
            );
            return (
              currentOptions.agents.some(
                (agent) => agent.id === schedule.agentId,
              ) &&
              (!currentOptions.canStart ||
                currentOptions.canStart(
                  schedule.agentId,
                  schedule.providerId,
                )) &&
              provider?.authState === "connected" &&
              (schedule.executionKind === "agent"
                ? supportsSharedComputerTools(provider) &&
                  model?.capabilities?.tools !== false
                : provider.backendType === "codex-app-server") &&
              model?.available === true &&
              model.capabilities?.streaming !== false
            );
          }) ?? firstDue(schedules);
        if (!due) return;
        if (
          currentOptions.canStart &&
          !currentOptions.canStart(due.agentId, due.providerId)
        ) {
          publish({
            phase: "claiming",
            scheduleId: due.id,
            message: "This task is queued while its agent or provider is busy.",
          });
          return;
        }
        const agent = currentOptions.agents.find(
          (candidate) => candidate.id === due.agentId,
        );
        if (!agent) {
          publish({
            phase: "failed",
            scheduleId: due.id,
            message:
              "This task is waiting for its named agent to be available.",
          });
          return;
        }
        const provider = currentOptions.providers.find(
          (candidate) => candidate.id === due.providerId,
        );
        if (
          !provider ||
          (due.executionKind !== "agent" &&
            provider.backendType !== "codex-app-server") ||
          (due.executionKind === "agent" &&
            !supportsSharedComputerTools(provider)) ||
          provider.authState !== "connected"
        ) {
          publish({
            phase: "failed",
            scheduleId: due.id,
            message:
              "Reconnect this task's saved provider with support for its workflow.",
          });
          return;
        }
        const modelDefinition = provider.models.find(
          (candidate) => candidate.id === due.model,
        );
        if (
          !modelDefinition?.available ||
          modelDefinition.capabilities?.streaming === false ||
          (due.executionKind === "agent" &&
            modelDefinition.capabilities?.tools === false)
        ) {
          publish({
            phase: "failed",
            scheduleId: due.id,
            message:
              "Scheduled work is waiting for its saved model to be available.",
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
        const onQueued = async (attemptId = immutableAttemptId) => {
          if (!isCurrent())
            throw new Error("This automation was stopped before dispatch.");
          if (bound) return;
          identity.attemptId = attemptId;
          await bindLocalScheduleDispatch(identity);
          bound = true;
          if (claim?.projectId && claim.executionKind !== "agent")
            release = await currentOptions.onBound?.(
              identity.attemptId,
              async () => {
                stopped = true;
                await cancelRun();
              },
            );
          leaseTimer = setInterval(() => {
            void renewLocalScheduleDispatch(identity).catch(() => {
              if (isCurrent()) void cancelRun().catch(() => undefined);
            });
          }, 60_000);
          statusTimer = setInterval(() => {
            void listLocalSchedules(workspaceId)
              .then((latest) => {
                const current = latest.find(
                  (schedule) => schedule.id === claim?.scheduleId,
                );
                if (isCurrent() && (!current || current.status !== "enabled"))
                  void cancelRun().catch(() => undefined);
              })
              .catch(() => undefined);
          }, 5_000);
        };
        const onReady = (cancel: () => Promise<void>) => {
          runCancel = cancel;
          if (cancelRequested) void cancelRun().catch(() => undefined);
        };
        const result =
          claim.executionKind === "agent"
            ? await (async () => {
                if (!currentOptions.runWork)
                  throw new Error(
                    "Scheduled agent execution is unavailable in this workspace.",
                  );
                const staged = await stageLocalScheduleDispatch({
                  workspaceId,
                  occurrenceId: immutableOccurrenceId,
                  claimToken: claim!.claimToken,
                });
                if (!isCurrent())
                  throw new Error(
                    "The workspace changed before the automation could start.",
                  );
                currentOptions.onThreadCreated?.(agent.id, staged.threadId);
                publish({
                  phase: "running",
                  scheduleId: claim!.scheduleId,
                  occurrenceId: immutableOccurrenceId,
                  threadId: staged.threadId,
                });
                return currentOptions.runWork({ ...staged, onQueued, onReady });
              })()
            : await service.runScheduledResearch({
                attemptId: immutableAttemptId,
                workspaceId,
                scheduleId: claim.scheduleId,
                occurrenceId: immutableOccurrenceId,
                prompt: claim.prompt,
                projectContext: claim.projectId
                  ? await currentOptions.projectContext?.(
                      claim.projectId,
                      claim.prompt,
                    )
                  : undefined,
                providerId: claim.providerId,
                model: claim.model,
                agent: { ...agent, reasoningEffort: claim.reasoningEffort },
                provider,
                modelDefinition,
                isCurrent,
                onThreadCreated: (threadId) => {
                  if (isCurrent())
                    currentOptions.onThreadCreated?.(agent.id, threadId);
                },
                onQueued: () => onQueued(),
                onBackendReady: onReady,
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
        if (!bound)
          throw new Error(
            result.message ??
              "This automation ended before an execution attempt could start.",
          );
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
        finalized = true;
        if (leaseTimer) clearInterval(leaseTimer);
        if (statusTimer) clearInterval(statusTimer);
        if (activeCancel === cancelRun) activeCancel = undefined;
        release?.();
        if (claim) await currentOptions.onFinished?.().catch(() => undefined);
        polling = false;
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), 15_000);
    return () => {
      disposed = true;
      clearInterval(timer);
      void activeCancel?.().catch(() => undefined);
    };
  }, [options.runtimeReady, options.workspaceId]);
}

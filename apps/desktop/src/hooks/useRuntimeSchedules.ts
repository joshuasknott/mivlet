import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ScheduledJob,
  SchedulerQueueEntry,
  WorkflowDefinition,
  WorkflowRun
} from "@fable/protocol";
import { missedOccurrences, nextOccurrence } from "@fable/connectors";
import {
  enqueueRuntimeJobRun,
  listRuntimeSchedulerJobs,
  listRuntimeSchedulerQueue,
  listRuntimeWorkflowDefinitions,
  listRuntimeWorkflowRuns,
  saveRuntimeScheduledJob,
  wireToWorkflowRun
} from "../runtime";
import { toSlug } from "../lib/helpers";

export interface RuntimeScheduleScope {
  workspaceId: string;
  projectId: string | null;
}

export interface RuntimeScheduleState {
  jobs: ScheduledJob[];
  queue: SchedulerQueueEntry[];
  definitions: WorkflowDefinition[];
  runs: WorkflowRun[];
}

const EMPTY_SCHEDULE_STATE: RuntimeScheduleState = {
  jobs: [],
  queue: [],
  definitions: [],
  runs: []
};

export const runtimeScheduleQueryKeys = {
  workspace: (scope: RuntimeScheduleScope | null) =>
    ["runtime-schedules", scope?.workspaceId ?? "unavailable", scope?.projectId ?? "workspace"] as const
};

async function loadRuntimeScheduleState(scope: RuntimeScheduleScope | null): Promise<RuntimeScheduleState> {
  if (!scope) return EMPTY_SCHEDULE_STATE;
  const [jobs, queue, definitions, runs] = await Promise.all([
    listRuntimeSchedulerJobs(),
    listRuntimeSchedulerQueue(),
    listRuntimeWorkflowDefinitions(),
    listRuntimeWorkflowRuns()
  ]);
  const now = new Date();
  const recoveredJobs = (jobs ?? []).map((job) => {
    if (job.status !== "active") return job;
    try {
      const previous = new Date(job.lastRunAt || job.createdAt);
      const missed = missedOccurrences(job.trigger, previous, now, job.missedRunPolicy);
      for (const occurrence of missed) {
        const scheduledAt = occurrence.toISOString();
        void enqueueRuntimeJobRun(
          job.id,
          `workflow-run-${toSlug(job.id)}-${toSlug(scheduledAt)}`,
          scheduledAt
        ).catch(() => undefined);
      }
      const nextRunAt = nextOccurrence(job.trigger, now)?.toISOString() ?? "";
      const recovered = { ...job, nextRunAt, updatedAt: now.toISOString() };
      if (nextRunAt) {
        void enqueueRuntimeJobRun(
          job.id,
          `workflow-run-${toSlug(job.id)}-${toSlug(nextRunAt)}`,
          nextRunAt
        ).catch(() => undefined);
      }
      void saveRuntimeScheduledJob(recovered);
      return recovered;
    } catch {
      return job;
    }
  });
  return {
    jobs: recoveredJobs,
    queue: queue ?? [],
    definitions: definitions ?? [],
    runs: (runs ?? []).map(wireToWorkflowRun)
  };
}

export function useRuntimeSchedules(scope: RuntimeScheduleScope | null) {
  const queryClient = useQueryClient();
  const queryKey = runtimeScheduleQueryKeys.workspace(scope);
  const query = useQuery({
    queryKey,
    queryFn: () => loadRuntimeScheduleState(scope),
    enabled: scope !== null,
    networkMode: "always",
    retry: 1,
    staleTime: 5_000
  });

  const data = query.data ?? EMPTY_SCHEDULE_STATE;
  const setScheduleData = (updater: (current: RuntimeScheduleState) => RuntimeScheduleState) => {
    queryClient.setQueryData<RuntimeScheduleState>(queryKey, (current) =>
      updater(current ?? EMPTY_SCHEDULE_STATE)
    );
  };

  return {
    queryKey,
    // Mutations must not begin while a scoped hydration can still replace the
    // optimistic cache with the older snapshot it started loading.
    schedulesReady: scope === null || !query.isPending,
    scheduleLoadError: query.error instanceof Error ? query.error.message : null,
    retryScheduleLoad: query.refetch,
    // A null scope is the local preview/legacy fallback. Refetching it can only
    // return EMPTY_SCHEDULE_STATE, which would discard optimistic create/edit
    // state and briefly unmount the row the user is interacting with.
    invalidateSchedules: () =>
      scope ? queryClient.invalidateQueries({ queryKey }) : Promise.resolve(),
    scheduledJobs: data.jobs,
    schedulerQueue: data.queue,
    workflowDefinitions: data.definitions,
    workflowRuns: data.runs,
    setScheduledJobs: (updater: (current: ScheduledJob[]) => ScheduledJob[]) =>
      setScheduleData((current) => ({ ...current, jobs: updater(current.jobs) })),
    setSchedulerQueue: (updater: (current: SchedulerQueueEntry[]) => SchedulerQueueEntry[]) =>
      setScheduleData((current) => ({ ...current, queue: updater(current.queue) })),
    setWorkflowDefinitions: (updater: (current: WorkflowDefinition[]) => WorkflowDefinition[]) =>
      setScheduleData((current) => ({ ...current, definitions: updater(current.definitions) })),
    setWorkflowRuns: (updater: (current: WorkflowRun[]) => WorkflowRun[]) =>
      setScheduleData((current) => ({ ...current, runs: updater(current.runs) }))
  };
}

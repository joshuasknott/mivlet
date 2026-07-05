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
import { hasTauriRuntime } from "../lib/persistence";

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

export const runtimeScheduleScope: RuntimeScheduleScope = {
  workspaceId: "default",
  projectId: null
};

export const runtimeScheduleQueryKeys = {
  workspace: (scope: RuntimeScheduleScope) =>
    ["runtime-schedules", scope.workspaceId, scope.projectId ?? "workspace"] as const
};

async function loadRuntimeScheduleState(): Promise<RuntimeScheduleState> {
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

export function useRuntimeSchedules(scope = runtimeScheduleScope) {
  const queryClient = useQueryClient();
  const queryKey = runtimeScheduleQueryKeys.workspace(scope);
  const query = useQuery({
    queryKey,
    queryFn: loadRuntimeScheduleState,
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
    schedulesReady: !hasTauriRuntime() || !query.isPending,
    scheduleLoadError: query.error instanceof Error ? query.error.message : null,
    retryScheduleLoad: query.refetch,
    invalidateSchedules: () => queryClient.invalidateQueries({ queryKey }),
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

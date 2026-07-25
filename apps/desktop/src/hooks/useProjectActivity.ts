import { useCallback, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FIRST_WAVE_CONNECTOR_IDS } from "@fable/connectors";
import type { ThreadSummary } from "@fable/protocol";
import {
  listRuntimeProjectConnectionOptions
} from "../lib/project-runtime";
import {
  deleteRuntimeRoutine,
  listRuntimeRoutines,
  listRuntimeThreadMissionProgress,
  pauseRuntimeRoutine,
  resumeRuntimeRoutine,
  searchRuntimeArtifacts,
  type RuntimeRoutineTriggerSpec
} from "../runtime";

const MAX_PROJECT_THREADS = 20;
const MAX_MISSIONS_PER_THREAD = 6;
const MAX_PROJECT_ACTIVITY_ITEMS = 20;

export interface ProjectActivityMission {
  runId: string;
  threadId: string;
  title: string;
  state: string;
  detail: string;
  conversation: string;
}

export interface ProjectActivityRoutine {
  id: string;
  title: string;
  lifecycle: string;
  revision: number;
  status: string;
  detail: string;
}

export interface ProjectActivityArtifact {
  id: string;
  title: string;
  status: string;
  detail: string;
}

export interface ProjectActivityConnection {
  id: string;
  name: string;
  status: string;
}

export interface ProjectConnectionChoice extends ProjectActivityConnection {
  connectorId: string;
  selectable: boolean;
  searchable: boolean;
}

export interface ProjectActivityView {
  missions: ProjectActivityMission[];
  routines: ProjectActivityRoutine[];
  artifacts: ProjectActivityArtifact[];
  connections: ProjectActivityConnection[];
  connectionOptions: ProjectConnectionChoice[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
  refresh: () => void | Promise<unknown>;
  changeRoutine: (
    routine: ProjectActivityRoutine,
    action: "pause" | "resume" | "delete"
  ) => Promise<void>;
}

export interface UseProjectActivityOptions {
  workspaceId: string;
  projectId: string;
  connectionIds: readonly string[];
  threads: ThreadSummary[];
  enabled: boolean;
}

export const projectActivityQueryKeys = {
  scope: (
    workspaceId: string,
    projectId: string,
    threadIds: readonly string[],
    connectionIds: readonly string[]
  ) =>
    [
      "project-activity",
      workspaceId.trim() || "unavailable",
      projectId.trim() || "unavailable",
      [...threadIds],
      [...connectionIds]
    ] as const
};

export function useProjectActivity(options: UseProjectActivityOptions): ProjectActivityView {
  const workspaceId = options.workspaceId.trim();
  const projectId = options.projectId.trim();
  const threads = useMemo(
    () => [...options.threads]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_PROJECT_THREADS),
    [options.threads]
  );
  const threadIds = useMemo(() => threads.map((thread) => thread.id), [threads]);
  const connectionIds = useMemo(
    () => [...new Set(options.connectionIds)].sort(),
    [options.connectionIds]
  );
  const queryKey = projectActivityQueryKeys.scope(
    workspaceId,
    projectId,
    threadIds,
    connectionIds
  );
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const [missionLists, routinesResult, artifacts, connectionOptionsResult] =
        await Promise.all([
          Promise.all(
            threads.map((thread) =>
              listRuntimeThreadMissionProgress(thread.id, MAX_MISSIONS_PER_THREAD)
            )
          ),
          listRuntimeRoutines(projectId),
          searchRuntimeArtifacts({
            projectId: projectId as never,
            limit: MAX_PROJECT_ACTIVITY_ITEMS
          }),
          listRuntimeProjectConnectionOptions()
        ]);
      const threadTitles = new Map(threads.map((thread) => [thread.id, thread.title]));
      const projectedMissions = missionLists.flatMap((list, threadIndex) => {
        const thread = threads[threadIndex];
        if (!thread) return [];
        return list.progress.map(({ runId, progress }) => ({
          runId,
          threadId: thread.id,
          title: progress.summary,
          state: missionStateLabel(progress.state),
          detail: `${progress.completedSteps} of ${progress.totalSteps} steps · ${progress.nextAction}`,
          conversation: threadTitles.get(thread.id) ?? "Project conversation"
        }));
      });
      const missions = projectedMissions.slice(0, MAX_PROJECT_ACTIVITY_ITEMS);
      const routines = (routinesResult ?? [])
        .filter((bundle) => bundle.routine.status !== "deleted")
        .slice(0, MAX_PROJECT_ACTIVITY_ITEMS)
        .map((bundle) => ({
          id: bundle.routine.id,
          title: bundle.routine.title,
          lifecycle: bundle.routine.status,
          revision: bundle.routine.revision,
          status: routineStatusLabel(bundle.routine.status),
          detail: routineTriggerLabel(bundle.triggers[0]?.spec)
        }));
      const projectedArtifacts = artifacts
        .slice(0, MAX_PROJECT_ACTIVITY_ITEMS)
        .map(({ artifact, currentVersion }) => ({
          id: artifact.id,
          title: artifact.title,
          status: artifactStatusLabel(artifact.status),
          detail: `${artifactKindLabel(artifact.kind)} · Version ${currentVersion.version}`
        }));
      const referencedConnectionIds = new Set<string>(connectionIds);
      for (const bundle of routinesResult ?? []) {
        for (const trigger of bundle.triggers) {
          if (trigger.spec.kind === "connection-event") {
            referencedConnectionIds.add(trigger.spec.connectionId);
          }
        }
      }
      for (const result of artifacts) {
        for (const source of result.artifact.sourceProvenance) {
          if (source.connectionId) referencedConnectionIds.add(source.connectionId);
        }
        for (const citation of result.currentVersion.citations) {
          if (citation.source.connectionId) referencedConnectionIds.add(citation.source.connectionId);
        }
      }
      const availableConnections = new Map(
        (connectionOptionsResult ?? []).map((connection) => [
          connection.connectionId,
          connection
        ])
      );
      const connections = [...referencedConnectionIds].sort().map((connectionId) => {
        const available = availableConnections.get(connectionId);
        return {
          id: connectionId,
          name: available?.displayName ?? "Connection unavailable",
          status: available ? connectionStatusLabel(available.healthState) : "Needs attention"
        };
      });
      const connectionOptions = (connectionOptionsResult ?? [])
        .map((connection) => ({
          id: connection.connectionId,
          connectorId: connection.connectorId,
          name: connection.displayName,
          status: connectionStatusLabel(connection.healthState),
          selectable: connection.selectable,
          searchable: (FIRST_WAVE_CONNECTOR_IDS as readonly string[])
            .includes(connection.connectorId)
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
      return {
        missions,
        routines,
        artifacts: projectedArtifacts,
        connections,
        connectionOptions,
        truncated:
          options.threads.length > threads.length
          || missionLists.some((list) => list.truncated)
          || missionLists.some((list) => list.unavailableCount > 0)
          || projectedMissions.length > missions.length
          || (routinesResult?.length ?? 0) > routines.length
          || artifacts.length >= MAX_PROJECT_ACTIVITY_ITEMS
      };
    },
    enabled: options.enabled && Boolean(workspaceId && projectId),
    networkMode: "always",
    retry: 1,
    staleTime: 5_000
  });

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey }),
    [queryClient, queryKey]
  );
  const changeRoutine = useCallback(async (
    routine: ProjectActivityRoutine,
    action: "pause" | "resume" | "delete"
  ) => {
    const input = {
      projectId,
      routineId: routine.id,
      expectedRevision: routine.revision,
      ...(action === "pause" ? { reason: "Paused from Project activity." } : {})
    };
    if (action === "pause") await pauseRuntimeRoutine(input);
    else if (action === "resume") await resumeRuntimeRoutine(input);
    else await deleteRuntimeRoutine(input);
    await queryClient.invalidateQueries({ queryKey });
  }, [projectId, queryClient, queryKey]);

  useEffect(() => {
    if (!options.enabled) return;
    const handleChange = () => void refresh();
    window.addEventListener("fable:routines-changed", handleChange);
    return () => window.removeEventListener("fable:routines-changed", handleChange);
  }, [options.enabled, refresh]);

  return {
    missions: query.data?.missions ?? [],
    routines: query.data?.routines ?? [],
    artifacts: query.data?.artifacts ?? [],
    connections: query.data?.connections ?? [],
    connectionOptions: query.data?.connectionOptions ?? [],
    loading: options.enabled && query.isPending,
    error: query.error instanceof Error ? query.error.message : null,
    truncated: query.data?.truncated ?? false,
    refresh,
    changeRoutine
  };
}

function missionStateLabel(state: string): string {
  switch (state) {
    case "ready": return "Ready";
    case "running": return "Running";
    case "waiting": return "Waiting";
    case "blocked": return "Blocked";
    case "complete": return "Complete";
    case "cancelled": return "Cancelled";
    default: return "Unavailable";
  }
}

function routineStatusLabel(status: string): string {
  switch (status) {
    case "draft": return "Draft";
    case "active": return "Active";
    case "paused": return "Paused";
    case "retired": return "Retired";
    default: return "Unavailable";
  }
}

function routineTriggerLabel(
  trigger: RuntimeRoutineTriggerSpec | undefined
): string {
  if (!trigger) return "No active trigger";
  if (trigger.kind === "time-once") return "Runs once";
  if (trigger.kind === "time-recurring") {
    const frequency = trigger.recurrence.frequency;
    return `${frequency[0]?.toLocaleUpperCase() ?? ""}${frequency.slice(1)} schedule`;
  }
  if (trigger.kind === "connection-event") return "Runs from a project-used Connection";
  if (trigger.kind === "follow-up") return "Runs as a follow-up";
  if (trigger.kind === "monitoring") return "Runs when its monitor matches";
  if (trigger.kind === "threshold") return "Runs when its threshold matches";
  return "Runs from a verified webhook";
}

function artifactStatusLabel(status: string): string {
  return status.split("-").map(capitalize).join(" ");
}

function artifactKindLabel(kind: string): string {
  return kind.split("-").map(capitalize).join(" ");
}

function connectionStatusLabel(status: string): string {
  return status === "healthy" || status === "connected"
    ? "Available"
    : status === "degraded"
      ? "Limited"
      : "Needs attention";
}

function capitalize(value: string): string {
  return value ? `${value[0]!.toLocaleUpperCase()}${value.slice(1)}` : value;
}

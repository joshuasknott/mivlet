import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  achieveRuntimeGoal,
  archiveRuntimeGoal,
  createRuntimeGoal,
  getGoalRuntimePersistence,
  listRuntimeGoals,
  restoreRuntimeGoal,
  updateRuntimeGoal,
  type GoalProjectFilter,
  type RuntimeGoalCreate,
  type RuntimeGoalTransition,
  type RuntimeGoalUpdate
} from "../lib/goal-runtime";

export const goalQueryKeys = {
  scope: (workspaceId: string | null | undefined, projectId: GoalProjectFilter) => [
    "goals",
    workspaceId?.trim() || "unavailable",
    projectId === undefined ? "all" : projectId === null ? "workspace" : `project:${projectId}`
  ] as const
};

export function useGoals(workspaceId: string | null | undefined, projectId?: string | null) {
  const workspace = workspaceId?.trim() || null;
  const queryClient = useQueryClient();
  const queryKey = goalQueryKeys.scope(workspace, projectId);
  const query = useQuery({
    queryKey,
    queryFn: () => listRuntimeGoals(workspace!, projectId),
    enabled: workspace !== null,
    networkMode: "always",
    retry: 1,
    staleTime: 5_000
  });

  const refresh = useCallback(async () => {
    if (!workspace) return [];
    const goals = await listRuntimeGoals(workspace, projectId);
    queryClient.setQueryData(queryKey, goals);
    return goals;
  }, [projectId, queryClient, queryKey, workspace]);

  const mutateAndRefresh = useCallback(async <T,>(mutation: () => Promise<T>) => {
    const result = await mutation();
    await refresh();
    return result;
  }, [refresh]);

  const create = useCallback((input: RuntimeGoalCreate) => {
    if (!workspace) return Promise.reject(new Error("An active workspace is required for goals."));
    return mutateAndRefresh(() => createRuntimeGoal(workspace, input));
  }, [mutateAndRefresh, workspace]);

  const update = useCallback((input: RuntimeGoalUpdate) => {
    if (!workspace) return Promise.reject(new Error("An active workspace is required for goals."));
    return mutateAndRefresh(() => updateRuntimeGoal(workspace, input));
  }, [mutateAndRefresh, workspace]);

  const transition = useCallback((mutation: typeof achieveRuntimeGoal, input: RuntimeGoalTransition) => {
    if (!workspace) return Promise.reject(new Error("An active workspace is required for goals."));
    return mutateAndRefresh(() => mutation(workspace, input));
  }, [mutateAndRefresh, workspace]);

  const records = query.data ?? [];
  return useMemo(() => ({
    queryKey,
    activeGoals: records.filter((goal) => goal.lifecycle === "active"),
    achievedGoals: records.filter((goal) => goal.lifecycle === "achieved"),
    archivedGoals: records.filter((goal) => goal.lifecycle === "archived"),
    loading: workspace !== null && query.isPending,
    error: query.error instanceof Error ? query.error.message : null,
    persistence: getGoalRuntimePersistence(),
    refresh,
    create,
    update,
    achieve: (input: RuntimeGoalTransition) => transition(achieveRuntimeGoal, input),
    archive: (input: RuntimeGoalTransition) => transition(archiveRuntimeGoal, input),
    restore: (input: RuntimeGoalTransition) => transition(restoreRuntimeGoal, input)
  }), [create, query.error, query.isPending, queryKey, records, refresh, transition, update, workspace]);
}

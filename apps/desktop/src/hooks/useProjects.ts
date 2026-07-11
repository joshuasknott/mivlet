import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  archiveRuntimeProject,
  createRuntimeProject,
  deleteRuntimeProject,
  getProjectRuntimePersistence,
  listRuntimeProjects,
  restoreRuntimeProject,
  updateRuntimeProject,
  type RuntimeProjectCreate,
  type RuntimeProjectTransition,
  type RuntimeProjectUpdate
} from "../lib/project-runtime";

export const projectQueryKeys = {
  workspace: (workspaceId: string | null | undefined) =>
    ["projects", workspaceId?.trim() || "unavailable"] as const
};

export function useProjects(workspaceId: string | null | undefined) {
  const normalizedWorkspaceId = workspaceId?.trim() || null;
  const queryClient = useQueryClient();
  const queryKey = projectQueryKeys.workspace(normalizedWorkspaceId);
  const query = useQuery({
    queryKey,
    queryFn: () => listRuntimeProjects(normalizedWorkspaceId!, true),
    enabled: normalizedWorkspaceId !== null,
    networkMode: "always",
    retry: 1,
    staleTime: 5_000
  });

  const refresh = useCallback(async () => {
    if (!normalizedWorkspaceId) return [];
    const projects = await listRuntimeProjects(normalizedWorkspaceId, true);
    queryClient.setQueryData(queryKey, projects);
    return projects;
  }, [normalizedWorkspaceId, queryClient, queryKey]);

  const mutateAndRefresh = useCallback(async <T,>(mutation: () => Promise<T>) => {
    const result = await mutation();
    await refresh();
    return result;
  }, [refresh]);

  const create = useCallback((input: RuntimeProjectCreate) => {
    if (!normalizedWorkspaceId) return Promise.reject(new Error("An active workspace is required for projects."));
    return mutateAndRefresh(() => createRuntimeProject(normalizedWorkspaceId, input));
  }, [mutateAndRefresh, normalizedWorkspaceId]);

  const update = useCallback((input: RuntimeProjectUpdate) => {
    if (!normalizedWorkspaceId) return Promise.reject(new Error("An active workspace is required for projects."));
    return mutateAndRefresh(() => updateRuntimeProject(normalizedWorkspaceId, input));
  }, [mutateAndRefresh, normalizedWorkspaceId]);

  const transition = useCallback((
    mutation: typeof archiveRuntimeProject,
    input: RuntimeProjectTransition
  ) => {
    if (!normalizedWorkspaceId) return Promise.reject(new Error("An active workspace is required for projects."));
    return mutateAndRefresh(() => mutation(normalizedWorkspaceId, input));
  }, [mutateAndRefresh, normalizedWorkspaceId]);

  const records = query.data ?? [];
  return useMemo(() => ({
    queryKey,
    projects: records.filter((project) => project.lifecycle === "active"),
    archivedProjects: records.filter((project) => project.lifecycle === "archived"),
    loading: normalizedWorkspaceId !== null && query.isPending,
    error: query.error instanceof Error ? query.error.message : null,
    persistence: getProjectRuntimePersistence(),
    refresh,
    create,
    update,
    archive: (input: RuntimeProjectTransition) => transition(archiveRuntimeProject, input),
    restore: (input: RuntimeProjectTransition) => transition(restoreRuntimeProject, input),
    remove: (input: RuntimeProjectTransition) => transition(deleteRuntimeProject, input)
  }), [create, normalizedWorkspaceId, query.error, query.isPending, queryKey, records, refresh, transition, update]);
}

import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { validateLocalFileCandidate, type LocalTextFileCandidate } from "@fable/connectors";
import {
  importRuntimeLocalKnowledgeSource,
  loadRuntimeImportedKnowledgeSources,
  searchRuntimeKnowledgeSources,
  type RuntimeKnowledgeScopeOverride
} from "../runtime";
import { getRuntimeProject } from "../lib/project-runtime";
import { readFileAsText } from "../lib/helpers";

export interface UseProjectKnowledgeOptions {
  workspaceId: string;
  projectId: string;
  enabled: boolean;
}

export const projectKnowledgeQueryKeys = {
  scope: (workspaceId: string, projectId: string) =>
    ["project-knowledge", workspaceId.trim() || "unavailable", projectId.trim() || "unavailable"] as const
};

export function useProjectKnowledge(options: UseProjectKnowledgeOptions) {
  const workspaceId = options.workspaceId.trim();
  const projectId = options.projectId.trim();
  const scope = useMemo<RuntimeKnowledgeScopeOverride>(
    () => ({ workspaceId, projectId }),
    [projectId, workspaceId]
  );
  const queryKey = projectKnowledgeQueryKeys.scope(workspaceId, projectId);
  const queryClient = useQueryClient();
  const [mutationError, setMutationError] = useState<string | null>(null);
  const query = useQuery({
    queryKey,
    queryFn: async () => (await loadRuntimeImportedKnowledgeSources(scope)) ?? [],
    enabled: options.enabled && Boolean(workspaceId && projectId),
    networkMode: "always",
    retry: 1,
    staleTime: 5_000
  });

  const refresh = useCallback(async () => {
    if (!options.enabled || !workspaceId || !projectId) return [];
    setMutationError(null);
    const sources = (await loadRuntimeImportedKnowledgeSources(scope)) ?? [];
    queryClient.setQueryData(queryKey, sources);
    return sources;
  }, [options.enabled, projectId, queryClient, queryKey, scope, workspaceId]);

  const surfaceError = useCallback(async <T,>(work: () => Promise<T>) => {
    setMutationError(null);
    try {
      return await work();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Fable could not complete the knowledge request.";
      setMutationError(message);
      throw error;
    }
  }, []);

  const importFile = useCallback((file: File) => surfaceError(async () => {
    const project = await getRuntimeProject(workspaceId, projectId);
    if (!project || project.lifecycle !== "active") {
      throw new Error("Archived projects are read-only. Restore this project before importing knowledge.");
    }
    const content = await readFileAsText(file);
    const candidate: LocalTextFileCandidate = {
      name: file.name,
      content,
      sizeBytes: file.size,
      importedAt: new Date().toISOString()
    };
    const validation = validateLocalFileCandidate(candidate);
    if (!validation.ok) throw new Error(validation.message);
    const imported = await importRuntimeLocalKnowledgeSource(candidate, scope);
    if (!imported) throw new Error("Fable could not import project knowledge.");
    await refresh();
    return imported;
  }), [projectId, refresh, scope, surfaceError, workspaceId]);

  const sources = query.data ?? [];
  const search = useCallback((searchQuery: string) => surfaceError(async () => {
    const result = await searchRuntimeKnowledgeSources(searchQuery, sources, undefined, scope);
    if (!result) throw new Error("Fable could not search project knowledge.");
    return result;
  }), [scope, sources, surfaceError]);

  return useMemo(() => ({
    sources,
    loading: options.enabled && query.isPending,
    error: mutationError ?? (query.error instanceof Error ? query.error.message : null),
    refresh,
    importFile,
    search
  }), [importFile, mutationError, options.enabled, query.error, query.isPending, refresh, search, sources]);
}

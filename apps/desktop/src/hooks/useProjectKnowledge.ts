import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { validateLocalFileCandidate, type LocalTextFileCandidate } from "@fable/connectors";
import type { LocalFileImport } from "@fable/protocol";
import {
  importRuntimeLocalKnowledgeSource,
  loadRuntimeImportedKnowledgeSources,
  refreshRuntimeLocalKnowledgeSource,
  saveRuntimeImportedKnowledgeSources,
  searchRuntimeKnowledgeSources,
  type RuntimeKnowledgeScopeOverride
} from "../runtime";
import { getRuntimeProject } from "../lib/project-runtime";
import { readFileAsText } from "../lib/helpers";
import { buildLocalKnowledgeRefreshRequest } from "../lib/local-knowledge-refresh";

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
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  useEffect(() => {
    setMutationError(null);
    setActionStatus(null);
  }, [projectId, workspaceId]);
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
    const loaded = (await loadRuntimeImportedKnowledgeSources(scope)) ?? [];
    const cached = queryClient.getQueryData<LocalFileImport[]>(queryKey) ?? [];
    const retained = cached.filter((source) => "deletedAt" in source || "disabled" in source && source.disabled);
    const loadedIds = new Set(loaded.map((source) => source.id));
    const sources = [...loaded, ...retained.filter((source) => !loadedIds.has(source.id))];
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

  const allSources = query.data ?? [];
  const ensureWritable = useCallback(async () => {
    const project = await getRuntimeProject(workspaceId, projectId);
    if (!project || project.lifecycle !== "active") {
      throw new Error("Archived projects are read-only. Restore this project before changing knowledge.");
    }
  }, [projectId, workspaceId]);

  const persist = useCallback((next: typeof allSources) => surfaceError(async () => {
    await ensureWritable();
    const previous = queryClient.getQueryData<typeof allSources>(queryKey) ?? [];
    queryClient.setQueryData(queryKey, next);
    try {
      const saved = await saveRuntimeImportedKnowledgeSources(next, scope);
      if (saved) {
        const savedIds = new Set(saved.map((source) => source.id));
        const retained = next.filter((source) => (source.disabled || source.deletedAt) && !savedIds.has(source.id));
        queryClient.setQueryData(queryKey, [...saved, ...retained]);
      }
      return saved ?? next;
    } catch (error) {
      queryClient.setQueryData(queryKey, previous);
      throw error;
    }
  }), [allSources, ensureWritable, queryClient, queryKey, scope, surfaceError]);

  const toggleDisabled = useCallback((sourceId: string) => {
    const target = allSources.find((source) => source.id === sourceId && !source.deletedAt);
    if (!target) return Promise.reject(new Error("That project source is no longer available."));
    return persist(allSources.map((source) => source.id === sourceId
      ? { ...source, disabled: !source.disabled, pinned: source.disabled ? source.pinned : false }
      : source));
  }, [allSources, persist]);

  const remove = useCallback((sourceId: string) => {
    const target = allSources.find((source) => source.id === sourceId && !source.deletedAt);
    if (!target) return Promise.reject(new Error("That project source is no longer available."));
    const deletedAt = new Date().toISOString();
    return persist(allSources.map((source) => source.id === sourceId
      ? { ...source, disabled: true, pinned: false, deletedAt }
      : source));
  }, [allSources, persist]);

  const updateFile = useCallback((sourceId: string, file: File) => surfaceError(async () => {
    await ensureWritable();
    const target = allSources.find((source) => source.id === sourceId && !source.deletedAt);
    if (!target) throw new Error("That project source is no longer available.");
    setActionStatus(null);
    const request = await buildLocalKnowledgeRefreshRequest(target, file);
    const response = await refreshRuntimeLocalKnowledgeSource(request, scope);
    if (!response) throw new Error("Fable could not update that file.");
    const authoritative = {
      ...response.source,
      pinned: target.pinned,
      disabled: target.disabled,
      ...(target.deletedAt ? { deletedAt: target.deletedAt } : {})
    };
    queryClient.setQueryData(queryKey, allSources.map((source) => source.id === sourceId ? authoritative : source));
    setActionStatus(response.outcome === "unchanged"
      ? "This source is already up to date."
      : `Updated from ${file.name}.`);
    return response;
  }), [allSources, ensureWritable, queryClient, queryKey, scope, surfaceError]);

  const sources = useMemo(() => allSources.filter((source) => !source.deletedAt), [allSources]);
  const liveSources = useMemo(
    () => allSources.filter((source) => !source.deletedAt && !source.disabled),
    [allSources]
  );
  const search = useCallback((searchQuery: string) => surfaceError(async () => {
    const result = await searchRuntimeKnowledgeSources(searchQuery, liveSources, undefined, scope);
    if (!result) throw new Error("Fable could not search project knowledge.");
    return result;
  }), [liveSources, scope, surfaceError]);

  return useMemo(() => ({
    sources,
    liveSources,
    loading: options.enabled && query.isPending,
    error: mutationError ?? (query.error instanceof Error ? query.error.message : null),
    actionStatus,
    refresh,
    importFile,
    search,
    updateFile,
    toggleDisabled,
    remove
  }), [actionStatus, importFile, liveSources, mutationError, options.enabled, query.error, query.isPending, refresh, remove, search, sources, toggleDisabled, updateFile]);
}

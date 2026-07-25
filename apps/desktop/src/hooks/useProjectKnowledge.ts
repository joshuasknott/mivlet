import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FIRST_WAVE_CONNECTOR_IDS,
  validateLocalFileCandidate,
  type LocalTextFileCandidate
} from "@fable/connectors";
import type {
  ConnectorSearchItem,
  FirstWaveConnectorId,
  KnowledgeSource,
  LocalFileImport
} from "@fable/protocol";
import {
  deleteRuntimeConnectorKnowledgeSource,
  importRuntimeConnectorItem,
  importRuntimeLocalKnowledgeSource,
  listRuntimeConnectorKnowledgeSources,
  loadRuntimeImportedKnowledgeSources,
  refreshRuntimeLocalKnowledgeSource,
  saveRuntimeImportedKnowledgeSources,
  searchRuntimeConnector,
  searchRuntimeKnowledgeSources,
  setRuntimeConnectorKnowledgeSourceDisabled,
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
    queryFn: async () => {
      const [local, connected] = await Promise.all([
        loadRuntimeImportedKnowledgeSources(scope),
        listRuntimeConnectorKnowledgeSources(scope)
      ]);
      return [...(local ?? []), ...(connected ?? [])] as KnowledgeSource[];
    },
    enabled: options.enabled && Boolean(workspaceId && projectId),
    networkMode: "always",
    retry: 1,
    staleTime: 5_000
  });

  const refresh = useCallback(async () => {
    if (!options.enabled || !workspaceId || !projectId) return [];
    setMutationError(null);
    const [local, connected] = await Promise.all([
      loadRuntimeImportedKnowledgeSources(scope),
      listRuntimeConnectorKnowledgeSources(scope)
    ]);
    const loaded = [...(local ?? []), ...(connected ?? [])] as KnowledgeSource[];
    const cached = queryClient.getQueryData<KnowledgeSource[]>(queryKey) ?? [];
    const retained = cached.filter((source) =>
      source.connectorId === "local-files"
      && (Boolean(source.deletedAt) || Boolean(source.disabled))
    );
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

  const persistLocal = useCallback((next: typeof allSources) => surfaceError(async () => {
    await ensureWritable();
    const previous = queryClient.getQueryData<typeof allSources>(queryKey) ?? [];
    queryClient.setQueryData(queryKey, next);
    try {
      const connected = next.filter((source) => source.connectorId !== "local-files");
      const local = next.filter((source) => source.connectorId === "local-files") as LocalFileImport[];
      const saved = await saveRuntimeImportedKnowledgeSources(local, scope);
      if (saved) {
        const savedIds = new Set(saved.map((source) => source.id));
        const retained = local.filter((source) =>
          (source.disabled || source.deletedAt) && !savedIds.has(source.id)
        );
        queryClient.setQueryData(queryKey, [...saved, ...retained, ...connected]);
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
    if (target.connectorId !== "local-files") {
      return surfaceError(async () => {
        await ensureWritable();
        const updated = await setRuntimeConnectorKnowledgeSourceDisabled(
          sourceId,
          !target.disabled,
          scope
        );
        if (!updated) throw new Error("Fable could not update that connected source.");
        await refresh();
        return updated;
      });
    }
    return persistLocal(allSources.map((source) => source.id === sourceId
      ? { ...source, disabled: !source.disabled, pinned: source.disabled ? source.pinned : false }
      : source));
  }, [allSources, ensureWritable, persistLocal, refresh, scope, surfaceError]);

  const remove = useCallback((sourceId: string) => {
    const target = allSources.find((source) => source.id === sourceId && !source.deletedAt);
    if (!target) return Promise.reject(new Error("That project source is no longer available."));
    if (target.connectorId !== "local-files") {
      return surfaceError(async () => {
        await ensureWritable();
        const deleted = await deleteRuntimeConnectorKnowledgeSource(sourceId, scope);
        if (!deleted) throw new Error("Fable could not delete that connected source.");
        await refresh();
        return deleted;
      });
    }
    const deletedAt = new Date().toISOString();
    return persistLocal(allSources.map((source) => source.id === sourceId
      ? { ...source, disabled: true, pinned: false, deletedAt }
      : source));
  }, [allSources, ensureWritable, persistLocal, refresh, scope, surfaceError]);

  const updateFile = useCallback((sourceId: string, file: File) => surfaceError(async () => {
    await ensureWritable();
    const target = allSources.find((source) => source.id === sourceId && !source.deletedAt);
    if (!target) throw new Error("That project source is no longer available.");
    if (target.connectorId !== "local-files") {
      throw new Error("Connected sources must be refreshed from their Connection.");
    }
    setActionStatus(null);
    const request = await buildLocalKnowledgeRefreshRequest(target as LocalFileImport, file);
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
  const searchConnection = useCallback((
    connectorId: string,
    connectionId: string,
    searchQuery: string
  ) => surfaceError(async () => {
    await ensureWritable();
    if (!(FIRST_WAVE_CONNECTOR_IDS as readonly string[]).includes(connectorId)) {
      throw new Error("This Connection does not support connected Project search.");
    }
    const result = await searchRuntimeConnector({
      connectorId: connectorId as FirstWaveConnectorId,
      query: searchQuery.trim(),
      limit: 20
    }, scope, connectionId);
    if (!result) throw new Error("Connected Project search is available only in the desktop app.");
    if (result.items.some((item) => item.connectionId !== connectionId)) {
      throw new Error("The active Connection changed during Project search.");
    }
    return result.items;
  }), [ensureWritable, scope, surfaceError]);
  const importConnectionItem = useCallback((item: ConnectorSearchItem) => surfaceError(async () => {
    await ensureWritable();
    if (!item.connectionId) throw new Error("Search again before importing this connected item.");
    const imported = await importRuntimeConnectorItem({
      connectorId: item.connectorId,
      item,
      importedAt: new Date().toISOString()
    }, scope, item.connectionId);
    if (!imported) throw new Error("Connected Project import is available only in the desktop app.");
    await refresh();
    setActionStatus(`Added ${imported.source.title} from its Connection.`);
    return imported.source;
  }), [ensureWritable, refresh, scope, surfaceError]);

  return useMemo(() => ({
    sources,
    liveSources,
    loading: options.enabled && query.isPending,
    error: mutationError ?? (query.error instanceof Error ? query.error.message : null),
    actionStatus,
    refresh,
    importFile,
    search,
    searchConnection,
    importConnectionItem,
    updateFile,
    toggleDisabled,
    remove
  }), [actionStatus, importConnectionItem, importFile, liveSources, mutationError, options.enabled, query.error, query.isPending, refresh, remove, search, searchConnection, sources, toggleDisabled, updateFile]);
}

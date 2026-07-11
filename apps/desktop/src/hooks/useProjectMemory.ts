import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { editMemory, exportMemories, forgetMemory, isLiveMemory } from "@fable/knowledge";
import type {
  KnowledgeSource,
  MemoryControlState,
  MemoryPromotionRequest,
  MemoryPromotionResponse,
  MemoryRecord
} from "@fable/protocol";
import {
  exportRuntimeMemoryState,
  loadRuntimeMemoryState,
  promoteRuntimeKnowledgeSourceToMemory,
  saveRuntimeMemoryState
} from "../runtime";

export interface UseProjectMemoryOptions {
  workspaceId: string;
  projectId: string;
  enabled: boolean;
}

type ProjectScope = { workspaceId: string; projectId: string };

// Runtime scope parameters land with the native project-memory slice. These
// structural signatures keep this independent hook compatible before and
// after that integration without weakening the public runtime contract.
const loadScopedMemory = loadRuntimeMemoryState as unknown as
  (scope: ProjectScope) => Promise<MemoryControlState | null>;
const saveScopedMemory = saveRuntimeMemoryState as unknown as
  (state: MemoryControlState, scope: ProjectScope) => Promise<MemoryControlState | null>;
const exportScopedMemory = exportRuntimeMemoryState as unknown as
  (state: MemoryControlState, scope: ProjectScope) => Promise<string | null>;
const promoteScopedSource = promoteRuntimeKnowledgeSourceToMemory as unknown as
  (request: MemoryPromotionRequest, scope: ProjectScope) => Promise<MemoryPromotionResponse | null>;

const EMPTY_STATE: MemoryControlState = { disabled: false, records: [] };

export const projectMemoryQueryKeys = {
  scope: (workspaceId: string, projectId: string) =>
    ["project-memory", workspaceId.trim() || "unavailable", projectId.trim() || "unavailable"] as const
};

export function useProjectMemory(options: UseProjectMemoryOptions) {
  const workspaceId = options.workspaceId.trim();
  const projectId = options.projectId.trim();
  const scope = useMemo<ProjectScope>(() => ({ workspaceId, projectId }), [projectId, workspaceId]);
  const queryKey = projectMemoryQueryKeys.scope(workspaceId, projectId);
  const queryClient = useQueryClient();
  const [mutationError, setMutationError] = useState<string | null>(null);

  const query = useQuery({
    queryKey,
    queryFn: async () => (await loadScopedMemory(scope)) ?? EMPTY_STATE,
    enabled: options.enabled && Boolean(workspaceId && projectId),
    networkMode: "always",
    retry: 1,
    staleTime: 5_000
  });

  const state = query.data ?? EMPTY_STATE;

  const refresh = useCallback(async () => {
    if (!options.enabled || !workspaceId || !projectId) return EMPTY_STATE;
    setMutationError(null);
    const loaded = (await loadScopedMemory(scope)) ?? EMPTY_STATE;
    queryClient.setQueryData(queryKey, loaded);
    return loaded;
  }, [options.enabled, projectId, queryClient, queryKey, scope, workspaceId]);

  const persist = useCallback(async (next: MemoryControlState) => {
    const previous = queryClient.getQueryData<MemoryControlState>(queryKey) ?? EMPTY_STATE;
    setMutationError(null);
    queryClient.setQueryData(queryKey, next);
    try {
      const saved = await saveScopedMemory(next, scope);
      const authoritative = saved ?? next;
      queryClient.setQueryData(queryKey, authoritative);
      return authoritative;
    } catch (cause) {
      queryClient.setQueryData(queryKey, previous);
      const message = cause instanceof Error ? cause.message : "Fable could not save this project memory.";
      setMutationError(message);
      throw cause;
    }
  }, [queryClient, queryKey, scope]);

  const promote = useCallback(async (source: KnowledgeSource) => {
    const previous = queryClient.getQueryData<MemoryControlState>(queryKey) ?? EMPTY_STATE;
    setMutationError(null);
    try {
      const result = await promoteScopedSource({
        source,
        decision: "once",
        decidedAt: new Date().toISOString(),
        state: previous
      }, scope);
      if (!result) throw new Error("Fable could not remember that source.");
      queryClient.setQueryData(queryKey, result.state);
      return result.record;
    } catch (cause) {
      queryClient.setQueryData(queryKey, previous);
      const message = cause instanceof Error ? cause.message : "Fable could not remember that source.";
      setMutationError(message);
      throw cause;
    }
  }, [queryClient, queryKey, scope]);

  const edit = useCallback((id: string, patch: { title: string; value: string }) => {
    const title = patch.title.trim();
    const value = patch.value.trim();
    if (!title || !value) return Promise.reject(new Error("Memory title and details are required."));
    const now = new Date().toISOString();
    return persist({
      ...state,
      records: state.records.map((record) => record.id === id
        ? { ...editMemory(record, { title, value }, now), freshness: "Updated now" }
        : record)
    });
  }, [persist, state]);

  const togglePin = useCallback((id: string) => {
    const target = state.records.find((record) => record.id === id);
    if (!target) return Promise.reject(new Error("That memory is no longer available."));
    if (!target.pinned && !isLiveMemory(target)) {
      return Promise.reject(new Error("Re-enable this memory before pinning it."));
    }
    return persist({
      ...state,
      records: state.records.map((record) => record.id === id ? { ...record, pinned: !record.pinned } : record)
    });
  }, [persist, state]);

  const toggleDisabled = useCallback((id: string) => {
    const target = state.records.find((record) => record.id === id);
    if (!target) return Promise.reject(new Error("That memory is no longer available."));
    const now = new Date().toISOString();
    return persist({
      ...state,
      records: state.records.map((record) => record.id === id
        ? { ...record, disabled: !record.disabled, pinned: record.disabled ? record.pinned : false, updatedAt: now }
        : record)
    });
  }, [persist, state]);

  const forget = useCallback((id: string) => {
    const now = new Date().toISOString();
    return persist({
      ...state,
      records: state.records.map((record) => record.id === id
        ? { ...forgetMemory(record, now), pinned: false }
        : record)
    });
  }, [persist, state]);

  const exportText = useCallback(async () => {
    setMutationError(null);
    try {
      return (await exportScopedMemory(state, scope)) ?? exportMemories(state.records);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Fable could not export this project memory.";
      setMutationError(message);
      throw cause;
    }
  }, [scope, state]);

  const loadContextRecords = useCallback(async () => {
    if (!options.enabled || !workspaceId || !projectId) return [];
    setMutationError(null);
    try {
      const loaded = (await loadScopedMemory(scope)) ?? EMPTY_STATE;
      queryClient.setQueryData(queryKey, loaded);
      return loaded.disabled ? [] : loaded.records.filter(isLiveMemory);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Fable could not load this project memory.";
      setMutationError(message);
      throw cause;
    }
  }, [options.enabled, projectId, queryClient, queryKey, scope, workspaceId]);

  const records = useMemo(() => state.records.filter((record) => !record.forgottenAt), [state.records]);
  const contextRecords = useMemo<MemoryRecord[]>(
    () => state.disabled ? [] : state.records.filter(isLiveMemory),
    [state.disabled, state.records]
  );

  return useMemo(() => ({
    records,
    disabled: state.disabled,
    loading: options.enabled && query.isPending,
    error: mutationError ?? (query.error instanceof Error ? query.error.message : null),
    refresh,
    promote,
    edit,
    togglePin,
    toggleDisabled,
    forget,
    exportText,
    loadContextRecords,
    contextRecords
  }), [contextRecords, edit, exportText, forget, loadContextRecords, mutationError, options.enabled, promote, query.error, query.isPending, records, refresh, state.disabled, toggleDisabled, togglePin]);
}

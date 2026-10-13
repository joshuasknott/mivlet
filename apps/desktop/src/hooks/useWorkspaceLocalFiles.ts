import type { CollaborationWorkItem } from "@mivlet/protocol";
import { QueryObserver, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo, useRef, useSyncExternalStore } from "react";
import { getLocalComputerReads, localComputerDataScope } from "./local-computer-reads";

/** Per-agent metadata only. Preview/open still rechecks native access and scope. */
export function useWorkspaceLocalFiles(workspaceId: string, agentIds: string[], work: CollaborationWorkItem[] = []) {
  const client = useQueryClient();
  const instance = useId();
  const dataScope = localComputerDataScope();
  const displayIds = JSON.stringify([...new Set(agentIds)]);
  const ids = JSON.stringify([...new Set(agentIds)].sort());
  const scopes = useMemo(() => (JSON.parse(ids) as string[]).map(agentId => ({
    agentId, reads: getLocalComputerReads(client, { workspaceId, agentId }, dataScope),
  })), [client, workspaceId, dataScope.id, ids]);
  const displayIndices = useMemo(() => {
    const indices = new Map(scopes.map((scope, index) => [scope.agentId, index]));
    return (JSON.parse(displayIds) as string[]).map(id => indices.get(id)!);
  }, [scopes, displayIds]);
  const revisions = scopes.map(({ agentId }) => JSON.stringify(work
    .filter(item => item.workspaceId === workspaceId && item.agentId === agentId)
    .map(item => [item.id, item.generation, item.status, item.updatedAt])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])))));
  // QueryObserver is already part of useQuery's shipped graph. Avoid importing
  // the separate multi-query wrapper solely for this bounded metadata list.
  const observers = useMemo(() => scopes.map(({ reads }, index) => new QueryObserver(client, {
    queryKey: [...reads.filesKey, revisions[index]],
    retry: false, staleTime: 10_000, gcTime: 30_000,
    enabled: Boolean(workspaceId),
    queryFn: () => reads.readFiles(revisions[index]),
  })), [client, scopes, workspaceId, revisions.join("\n")]);
  const snapshot = useRef<{
    observers: typeof observers;
    results: ReturnType<(typeof observers)[number]["getCurrentResult"]>[];
  } | null>(null);
  const subscribe = useCallback((notify: () => void) => {
    const releases = observers.map(observer => observer.subscribe(notify));
    return () => { for (const release of releases) release(); };
  }, [observers]);
  const getSnapshot = useCallback(() => {
    const results = observers.map(observer => observer.getCurrentResult());
    const previous = snapshot.current;
    if (previous?.observers === observers && results.every((result, index) => result === previous.results[index]))
      return previous.results;
    snapshot.current = { observers, results };
    return results;
  }, [observers]);
  const queries = useSyncExternalStore(subscribe, getSnapshot);
  const files = useMemo(() => ({
    data: displayIndices.map(index => ({ agentId: scopes[index].agentId,
      snapshot: scopes[index].reads.current() && !queries[index].isError ? queries[index].data ?? null : null,
      error: queries[index].isError ? queries[index].error instanceof Error ? queries[index].error.message : "Files could not be loaded."
        : queries[index].isSuccess && !queries[index].data && !queries[index].isFetching ? "Open the desktop app to view saved files." : "",
    })),
    isFetching: queries.some(query => query.isFetching),
  }), [queries, scopes, displayIndices]);
  const subscriptions = useRef(new Map<typeof scopes[number]["reads"], () => void>());
  useEffect(() => {
    const current = new Set(scopes.map(scope => scope.reads));
    for (const [reads, release] of subscriptions.current) if (!current.has(reads)) { release(); subscriptions.current.delete(reads); }
    for (const reads of current) if (!subscriptions.current.has(reads)) subscriptions.current.set(reads, reads.subscribe(instance, () => {}, false));
  }, [scopes, instance]);
  useEffect(() => () => {
    for (const release of subscriptions.current.values()) release();
    subscriptions.current.clear();
  }, []);
  useEffect(() => {
    const refresh = () => { for (const { reads } of scopes) if (!reads.leader()) reads.invalidateFiles(); };
    window.addEventListener("mivlet-builtin-plugins-changed", refresh);
    return () => window.removeEventListener("mivlet-builtin-plugins-changed", refresh);
  }, [scopes]);
  // Retain one inactive list per agent, rather than every streamed Work revision.
  useEffect(() => {
    scopes.forEach(({ reads }, index) => client.removeQueries({ queryKey: reads.filesKey, type: "inactive",
      predicate: query => query.queryKey.length > reads.filesKey.length && query.queryKey[reads.filesKey.length] !== revisions[index],
    }));
  }, [client, scopes, revisions.join("\n")]);
  return {
    ...files,
    refetch: () => Promise.all(observers.map(observer => observer.refetch({ cancelRefetch: false }))),
  };
}

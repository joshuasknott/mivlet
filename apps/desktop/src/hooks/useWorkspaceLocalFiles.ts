import type { CollaborationWorkItem } from "@mivlet/protocol";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo } from "react";
import { getLocalComputerReads, localComputerDataScope } from "./local-computer-reads";

/** Per-agent metadata only. Preview/open still rechecks native access and scope. */
export function useWorkspaceLocalFiles(workspaceId: string, agentIds: string[], work: CollaborationWorkItem[] = []) {
  const client = useQueryClient();
  const instance = useId();
  const dataScope = localComputerDataScope();
  const ids = JSON.stringify([...new Set(agentIds)].sort());
  const scopes = useMemo(() => (JSON.parse(ids) as string[]).map(agentId => ({
    agentId, reads: getLocalComputerReads(client, { workspaceId, agentId }, dataScope),
  })), [client, workspaceId, dataScope.id, ids]);
  const revisions = scopes.map(({ agentId }) => JSON.stringify(work
    .filter(item => item.workspaceId === workspaceId && item.agentId === agentId)
    .map(item => [item.id, item.generation, item.status, item.updatedAt])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])))));
  const queries = useQueries({ queries: scopes.map(({ reads }, index) => ({
    queryKey: [...reads.filesKey, revisions[index]],
    enabled: Boolean(workspaceId), retry: false, staleTime: 10_000, gcTime: 30_000,
    queryFn: () => reads.readFiles(revisions[index]),
  })) });
  useEffect(() => {
    const releases = scopes.map(({ reads }) => reads.subscribe(instance, () => {}, false));
    const refresh = () => { for (const { reads } of scopes) if (!reads.leader()) reads.invalidateFiles(); };
    window.addEventListener("mivlet-builtin-plugins-changed", refresh);
    return () => { window.removeEventListener("mivlet-builtin-plugins-changed", refresh); for (const release of releases) release(); };
  }, [scopes, instance]);
  // Retain one inactive list per agent, rather than every streamed Work revision.
  useEffect(() => {
    scopes.forEach(({ reads }, index) => client.removeQueries({ queryKey: reads.filesKey, type: "inactive",
      predicate: query => query.queryKey.length > reads.filesKey.length && query.queryKey[reads.filesKey.length] !== revisions[index],
    }));
  }, [client, scopes, revisions.join("\n")]);
  return {
    data: queries.map((query, index) => ({ agentId: scopes[index].agentId,
      snapshot: scopes[index].reads.current() && !query.isError ? query.data ?? null : null,
      error: query.isError ? query.error instanceof Error ? query.error.message : "Files could not be loaded."
        : query.isSuccess && !query.data && !query.isFetching ? "Open the desktop app to view saved files." : "",
    })),
    isFetching: queries.some(query => query.isFetching),
    refetch: () => Promise.all(queries.map(query => query.refetch({ cancelRefetch: false }))),
  };
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalProject, LocalProjectRunAuthor } from "@fable/protocol";
import { listLocalProjects, listLocalProjectRunAuthors } from "../runtime/domains/local-projects";

export function useLocalProjects(workspaceId: string | undefined, projectId: string | undefined, enabled: boolean) {
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [authors, setAuthors] = useState<LocalProjectRunAuthor[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const scope = `${enabled}:${workspaceId}:${projectId}`;
  const current = useRef(scope);
  current.current = scope;
  const refresh = useCallback(async () => {
    if (!enabled || !workspaceId) return;
    setLoading(true);
    try {
      const [nextProjects, nextAuthors] = await Promise.all([listLocalProjects(workspaceId), projectId ? listLocalProjectRunAuthors(workspaceId, projectId, 500) : Promise.resolve([])]);
      if (current.current !== scope) return;
      setProjects(nextProjects); setAuthors(nextAuthors); setError("");
    } catch (error) {
      if (current.current === scope) setError(error instanceof Error ? error.message : "Could not load projects.");
    } finally { if (current.current === scope) setLoading(false); }
  }, [enabled, workspaceId, projectId, scope]);
  useEffect(() => { setProjects([]); setAuthors([]); setError(""); }, [workspaceId, enabled]);
  useEffect(() => { setAuthors([]); void refresh(); }, [refresh]);
  return { projects, authors, error, loading, refresh, setProjects, setAuthors };
}

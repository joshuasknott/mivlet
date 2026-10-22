import { useCallback, useEffect, useRef, useState } from "react";
import {
  changeCloudComputer,
  cloudComputerStatus,
  type CloudComputerAction,
  type CloudComputerStatus,
} from "../runtime/domains/cloud-computers";

/** A late response never changes a different workspace or a newer request. */
export function useCloudComputer(workspaceId: string | undefined) {
  const [status, setStatus] = useState<CloudComputerStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const revision = useRef(0);

  const refresh = useCallback(async () => {
    if (!workspaceId || busy.current) return;
    const current = ++generation.current;
    setPending(true);
    try {
      const next = await cloudComputerStatus(workspaceId);
      if (current !== generation.current) return;
      revision.current = next.connectionRevision;
      setStatus(next);
      setError(null);
    } catch (reason) {
      if (current === generation.current)
        setError(
          reason instanceof Error
            ? reason.message
            : "Computer status is unavailable.",
        );
    } finally {
      if (current === generation.current) setPending(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    setStatus(null);
    setError(null);
    revision.current = 0;
    busy.current = false;
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);

  const act = useCallback(
    async (action: CloudComputerAction) => {
      if (!workspaceId || busy.current) return;
      busy.current = true;
      const current = ++generation.current;
      setPending(true);
      setError(null);
      try {
        const next = await changeCloudComputer(
          workspaceId,
          revision.current,
          action,
        );
        if (current !== generation.current || next === null) return;
        revision.current = next.connectionRevision;
        setStatus(next);
      } catch (reason) {
        if (current !== generation.current) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "The computer action did not finish. Refresh before retrying.",
        );
        // Recover only metadata, including a persisted uncertain operation. A
        // write is never replayed by this hook.
        try {
          const next = await cloudComputerStatus(workspaceId);
          if (current === generation.current) {
            revision.current = next.connectionRevision;
            setStatus(next);
          }
        } catch {
          if (current === generation.current) setStatus(null);
        }
      } finally {
        if (current === generation.current) {
          busy.current = false;
          setPending(false);
        }
      }
    },
    [workspaceId],
  );

  return { status, pending, error, refresh, act };
}

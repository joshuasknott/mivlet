import { useEffect, useRef, useState } from "react";
import { getActiveRuntimeDataScope } from "../../runtime-scope";

/** Keep asynchronous UI replies inside their original account and workspace. */
export function useHostedOperation(
  workspaceId: string,
  fallback: string,
  onFailure?: (name: string) => Promise<void>,
  disabled = false,
) {
  const scope = useRef(getActiveRuntimeDataScope()).current;
  const live = useRef(true);
  const busy = useRef(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const current = () => live.current && scope !== null
    && getActiveRuntimeDataScope() === scope && scope.workspaceId === workspaceId;
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  const run = async (name: string, action: () => Promise<void>) => {
    if (busy.current || !current() || disabled) return;
    busy.current = true;
    setPending(name);
    setError("");
    try {
      await action();
    } catch (reason) {
      if (current()) {
        setError(reason instanceof Error ? reason.message : fallback);
        await onFailure?.(name);
      }
    } finally {
      busy.current = false;
      if (current()) setPending("");
    }
  };
  return { busy, current, pending, error, setError, run };
}

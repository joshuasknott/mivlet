import { useCallback, useEffect, useRef, useState } from "react";
import {
  cloudViewerStatus,
  closeCloudViewer,
  openCloudViewer,
  resizeCloudViewer,
  type CloudViewerBounds,
  type CloudViewerState,
} from "../runtime/domains/cloud-computers";

/** The DOM supplies geometry only; the stream credential stays in native memory. */
export function useCloudViewer(
  workspaceId: string,
  machineId: string | undefined,
  revision: number,
) {
  const [viewer, setViewer] = useState<CloudViewerState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<CloudViewerState | null>(null);
  const busy = useRef(false);
  const epoch = useRef(0);
  useEffect(() => {
    const owner = ++epoch.current;
    current.current = null;
    busy.current = false;
    setViewer(null);
    setError(null);
    setPending(false);
    return () => {
      if (epoch.current === owner) epoch.current++;
      const active = current.current;
      current.current = null;
      if (active?.machineId && active.generation != null)
        void closeCloudViewer(
          workspaceId,
          active.machineId,
          active.generation,
        ).catch(() => {
          /* Native retains the uncertain revoke for recovery. */
        });
    };
  }, [workspaceId, machineId, revision]);

  const operate = useCallback(
    async (action: "open" | "close", bounds?: CloudViewerBounds) => {
      if (busy.current) return false;
      busy.current = true;
      setPending(true);
      setError(null);
      const owner = epoch.current;
      try {
        const active = current.current;
        let next: CloudViewerState;
        if (action === "open") {
          if (!machineId || !bounds) return false;
          next = await openCloudViewer(
            workspaceId,
            machineId,
            revision,
            bounds,
          );
        } else {
          if (
            !active?.machineId ||
            active.generation == null ||
            active.revoke === "acknowledged"
          )
            return true;
          next = await closeCloudViewer(
            workspaceId,
            active.machineId,
            active.generation,
          );
        }
        if (owner !== epoch.current) {
          if (next.open && next.machineId && next.generation != null)
            void closeCloudViewer(
              workspaceId,
              next.machineId,
              next.generation,
            ).catch(() => {});
          return false;
        }
        current.current = next;
        setViewer(next);
        return true;
      } catch (reason) {
        if (owner !== epoch.current) return false;
        setError(
          reason instanceof Error
            ? reason.message
            : "The desktop viewer is unavailable.",
        );
        // Read-only recovery obtains the new fence generation after an uncertain
        // close. Never automatically retry a write or mint another stream.
        try {
          const recovered = await cloudViewerStatus(workspaceId);
          if (owner === epoch.current) {
            current.current = recovered;
            setViewer(recovered);
          }
        } catch {
          /* Preserve the original error; Refresh can retry the read. */
        }
        return false;
      } finally {
        if (owner === epoch.current) {
          busy.current = false;
          setPending(false);
        }
      }
    },
    [workspaceId, machineId, revision],
  );

  const resize = useCallback(
    async (bounds: CloudViewerBounds) => {
      const active = current.current;
      if (
        !active?.open ||
        active.generation == null ||
        !machineId ||
        busy.current
      )
        return;
      const owner = epoch.current;
      try {
        await resizeCloudViewer(
          workspaceId,
          machineId,
          active.generation,
          bounds,
        );
      } catch (reason) {
        if (owner === epoch.current) {
          setError(
            reason instanceof Error
              ? reason.message
              : "The desktop viewer could not be resized.",
          );
          await operate("close");
        }
      }
    },
    [workspaceId, machineId, operate],
  );
  const open = useCallback(
    (bounds: CloudViewerBounds) => operate("open", bounds),
    [operate],
  );
  const close = useCallback(() => operate("close"), [operate]);
  return { viewer, pending, error, open, close, resize };
}

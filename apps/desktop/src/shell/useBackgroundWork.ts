import { useEffect } from "react";
import type { WorkspaceExecution } from "../lib/workspace-execution";
import { backgroundWorkerStatus } from "../runtime/domains/background-worker";

/** Reconnects views to native-owned records. It never dispatches or recovers a
 * provider attempt, and unmounting it has no execution side effect. */
export function useBackgroundWork(service: WorkspaceExecution) {
  useEffect(() => {
    let disposed = false;
    let reading = false;
    const revisions = new Map<string, string>();
    async function refresh() {
      if (disposed || reading) return;
      const native = service
        .getSnapshot()
        .data.work.filter(
          (work) => work.executionOwner === "native-background",
        );
      if (
        !native.some((work) =>
          ["queued", "running", "awaiting-approval"].includes(work.status),
        )
      )
        return;
      reading = true;
      try {
        await backgroundWorkerStatus();
        await service.refresh();
        if (disposed) return;
        for (const work of service.getSnapshot().data.work) {
          if (work.executionOwner !== "native-background") continue;
          const revision = `${work.generation}:${work.updatedAt}:${work.status}`;
          if (revisions.get(work.id) !== revision) {
            revisions.set(work.id, revision);
            await service.loadHistory(work.conversationId, true);
          }
        }
      } catch (error) {
        if (!disposed) service.report(error);
      } finally {
        reading = false;
      }
    }
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [service]);
}

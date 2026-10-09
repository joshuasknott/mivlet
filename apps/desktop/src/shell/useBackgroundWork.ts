import { useEffect } from "react";
import type { CollaborationWorkItem } from "@mivlet/protocol";
import type { WorkspaceExecution } from "../lib/workspace-execution";
import { backgroundWorkerStatus } from "../runtime/domains/background-worker";

const isActive = (work: CollaborationWorkItem) =>
  ["queued", "running", "awaiting-approval"].includes(work.status);

/** Reconnects views to native-owned records. It never dispatches or recovers a
 * provider attempt, and unmounting it has no execution side effect. */
export function useBackgroundWork(service: WorkspaceExecution) {
  useEffect(() => {
    let disposed = false;
    let reading = false;
    let nextIdleRead = 0;
    const revisions = new Map<string, string>();
    async function refresh() {
      if (disposed || reading) return;
      const native = service
        .getSnapshot()
        .data.work.filter(
          (work) => work.executionOwner === "native-background",
        );
      const activeIds = new Set(native.filter(isActive).map((work) => work.id));
      if (!activeIds.size && Date.now() < nextIdleRead) return;
      reading = true;
      nextIdleRead = Date.now() + 5000;
      try {
        let running = false;
        try {
          running = (await backgroundWorkerStatus()).running;
        } catch (error) {
          if (!disposed) service.report(error);
        }
        if (disposed || (!running && !activeIds.size)) return;
        // A control-channel failure must not hide a durable Stop or result.
        await service.refresh();
        if (disposed) return;
        const snapshot = service.getSnapshot();
        const changed = new Map<string, Array<[string, string]>>();
        for (const work of snapshot.data.work) {
          if (work.executionOwner !== "native-background") continue;
          const revision = `${work.generation}:${work.updatedAt}:${work.status}`;
          if (revisions.get(work.id) === revision) continue;
          if (
            isActive(work) ||
            activeIds.has(work.id) ||
            snapshot.histories[work.conversationId]
          ) {
            const entries = changed.get(work.conversationId) ?? [];
            entries.push([work.id, revision]);
            changed.set(work.conversationId, entries);
          } else {
            revisions.set(work.id, revision);
          }
        }
        for (const [conversation, entries] of changed) {
          if (disposed) return;
          await service.loadHistory(conversation, true);
          // Failed reads stay eligible for retry even if Work hasn't changed.
          for (const [id, revision] of entries) revisions.set(id, revision);
        }
      } catch (error) {
        if (!disposed) service.report(error);
      } finally {
        reading = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [service]);
}

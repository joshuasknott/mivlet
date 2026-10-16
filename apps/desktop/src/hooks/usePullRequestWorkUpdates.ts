import { useEffect } from "react";
import type { WorkspaceExecution } from "../lib/workspace-execution";
import { listenPullRequestWorkUpdates } from "../runtime/domains/pull-requests";

/** Refresh the existing executor after native admission; never dispatch here. */
export function usePullRequestWorkUpdates(
  workspaceId: string,
  service: Pick<WorkspaceExecution, "refresh" | "report">,
) {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const refresh = () => {
      if (!disposed)
        void service.refresh().catch((error: unknown) => {
          if (!disposed) service.report(error);
        });
    };
    void listenPullRequestWorkUpdates((changedWorkspace) => {
      if (changedWorkspace === workspaceId) refresh();
    })
      .then((release) => {
        if (disposed) release?.();
        else {
          unlisten = release;
          // Cover an admission between initial workspace load and subscription.
          if (release) refresh();
        }
      })
      .catch((error: unknown) => {
        if (!disposed) service.report(error);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [workspaceId, service]);
}

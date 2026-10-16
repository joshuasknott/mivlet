import { useEffect } from "react";
import type { WorkspaceExecution } from "../lib/workspace-execution";
import { hasNativeRuntimeAdapter } from "../runtime/adapters/select";
import { onMcpWorkChanged } from "../runtime/domains/mcp-server";

/** Native admission wakes the existing workspace execution owner. */
export function useMcpWorkEvents(
  service: Pick<WorkspaceExecution, "refresh" | "report">,
) {
  useEffect(() => {
    if (!hasNativeRuntimeAdapter()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const refresh = () => {
      if (!disposed)
        void service.refresh().catch((error) => service.report(error));
    };
    void onMcpWorkChanged(refresh)
      .then((release) => {
        if (disposed) release();
        else {
          unlisten = release;
          // Close the gap between workspace hydration and native subscription.
          refresh();
        }
      })
      .catch((error) => {
        if (!disposed) service.report(error);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [service]);
}

import { useEffect } from "react";
import type { WorkspaceExecution } from "../lib/workspace-execution";
import { hasNativeRuntimeAdapter } from "../runtime/adapters/select";
import { onMcpWorkChanged } from "../runtime/domains/mcp-server";

/** Native admission wakes the existing workspace execution owner. */
export function useMcpWorkEvents(service: WorkspaceExecution) {
  useEffect(() => {
    if (!hasNativeRuntimeAdapter()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onMcpWorkChanged(() => {
      if (!disposed) void service.refresh().catch((error) => service.report(error));
    }).then((release) => { if (disposed) release(); else unlisten = release; })
      .catch((error) => { if (!disposed) service.report(error); });
    return () => { disposed = true; unlisten?.(); };
  }, [service]);
}

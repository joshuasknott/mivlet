import { useEffect } from "react";
import type { WorkspaceExecution } from "../lib/workspace-execution";
import { refreshProviderAllowance } from "../runtime/domains/provider-usage";

/** Read-only reset validation; native dispatch admits into the existing Work queue. */
export function ProviderResetWorker({ service, suspended }: { service: WorkspaceExecution; suspended: boolean }) {
  useEffect(() => {
    if (suspended) return;
    let current = true; let busy = false;
    const sweep = async () => {
      if (!current || busy) return;
      const due = service.getSnapshot().data.work.filter(work => work.resetContinuation?.state === "armed" && Date.parse(work.resetContinuation.resetsAt) <= Date.now());
      if (!due.length) return;
      busy = true;
      try {
        await Promise.allSettled([...new Set(due.map(work => work.resetContinuation!.providerId))].map(refreshProviderAllowance));
        if (current) await service.command({ action: "dispatch-provider-resets" });
      } catch (failure) { if (current) service.report(failure); }
      finally { busy = false; }
    };
    const timer = window.setInterval(() => { void sweep(); }, 15_000);
    void sweep();
    return () => { current = false; window.clearInterval(timer); };
  }, [service, suspended]);
  return null;
}

import { useEffect } from "react";
import { restoreEventIngress } from "../runtime/domains/event-automations";

/** Restore only the account's opted-in local listener. Execution stays with
 * useLocalScheduleDispatcher and the canonical app-lifetime Work service. */
export function useEventIngress(
  workspaceId: string | undefined,
  ready: boolean,
) {
  useEffect(() => {
    if (workspaceId && ready)
      void restoreEventIngress(workspaceId).catch(() => undefined);
  }, [workspaceId, ready]);
}

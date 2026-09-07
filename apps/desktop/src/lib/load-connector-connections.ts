import { listRuntimeConnectorStatuses } from "../runtime";
import { openConnectorTools } from "./connector-mcp";
import { getActiveRuntimeDataScope } from "../runtime-scope";

/** Readiness is automatic, including migrated Vercel installations that only
 * discovered public tools. Coalesce focus/turn refreshes to avoid revision races. */
export async function listVerifiedConnectorStatuses() {
  const workspaceId = getActiveRuntimeDataScope()?.workspaceId;
  const manifests = await listRuntimeConnectorStatuses();
  if (!manifests || workspaceId !== getActiveRuntimeDataScope()?.workspaceId) return null;
  return Promise.all(manifests.map(async (connector) => {
    if (connector.id !== "vercel" || connector.connectionRoute !== "remote" || connector.status !== "connected") return connector;
    try {
      if (!workspaceId) throw new Error("Workspace unavailable");
      await verify(workspaceId);
      return connector;
    } catch {
      const summary = "Reconnect Vercel to restore account access.";
      return { ...connector, status: "needs-auth" as const, healthSummary: summary, health: { state: "error" as const, summary, checkedAt: new Date().toISOString() } };
    }
  }));
}
const checking = new Map<string, Promise<void>>();
function verify(workspaceId: string) {
  const current = checking.get(workspaceId);
  if (current) return current;
  const task = openConnectorTools(workspaceId, "marketplace-vercel").then(async (connection) => {
    await connection.client.close();
  }).finally(() => { checking.delete(workspaceId); });
  checking.set(workspaceId, task);
  return task;
}

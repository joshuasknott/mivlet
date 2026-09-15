import type { ApprovalRequest, ApprovalResolutionRequest } from "@fable/protocol";
import { beginRuntimeRemoteMcpAuthorization, commitRuntimeMcpServerConfiguration, listRuntimeMcpServerConfigurations, prepareRuntimeMcpServerConfiguration, setRuntimeMcpEnablement, type RuntimeMcpConnectionDetails, type RuntimeMcpServerConfiguration } from "../runtime/domains/mcp";
import { resolveRuntimeApprovalRequest } from "../runtime/domains/approvals";
import { remoteConnectorServerId, type RemoteConnector } from "../components/marketplace/remote-connectors";
import { openConnectorTools } from "./connector-mcp";
import { connectorConnectionsChanged, remoteConnectionReady } from "./connector-connections";

const connecting = new Map<string, Promise<RuntimeMcpConnectionDetails>>();
const once = (request: ApprovalRequest): ApprovalResolutionRequest => ({ request, decision: "once", decidedAt: new Date().toISOString() });

/** A single Connect action owns setup through readiness, even if its dialog is
 * closed. Every native step still resolves the exact account/workspace scope. */
export function connectRemoteConnector(workspaceId: string, preset: RemoteConnector) {
  const key = `${workspaceId}:${preset.id}`;
  const pending = connecting.get(key);
  if (pending) return pending;
  const task = finishConnection(workspaceId, preset, preset.endpoint).finally(() => {
    connecting.delete(key);
    connectorConnectionsChanged(workspaceId);
  });
  connecting.set(key, task);
  return task;
}

async function finishConnection(workspaceId: string, preset: RemoteConnector, endpoint: string) {
  const serverId = remoteConnectorServerId(preset.id);
  const servers = await listRuntimeMcpServerConfigurations(workspaceId);
  if (!servers) throw new Error("Account connections require the desktop app.");
  const existing = servers.find((server) => server.id === serverId);
  if (!existing || existing.disabled) {
    const configuration: RuntimeMcpServerConfiguration = { workspaceId, id: serverId, displayName: preset.name, transport: "streamable-http", endpoint,
      ...(existing ? { expectedRevision: existing.revision } : {}) };
    const prepared = await prepareRuntimeMcpServerConfiguration(configuration);
    if (!prepared) throw new Error("Account connections require the desktop app.");
    const resolution = once(prepared.approval);
    await resolveRuntimeApprovalRequest(resolution);
    if (!await commitRuntimeMcpServerConfiguration(configuration, resolution)) throw new Error("Could not save this connection.");
  }
  if (!await beginRuntimeRemoteMcpAuthorization(workspaceId, serverId)) throw new Error("Could not finish signing in.");
  const connection = await openConnectorTools(workspaceId, serverId);
  let enabled: RuntimeMcpConnectionDetails;
  try {
    if (connection.discovery.authorizationState !== "authorized" || connection.discovery.credentialState !== "available") {
      throw new Error("Sign-in did not finish. Connect again to restore access.");
    }
    if (!connection.tools.length) throw new Error(`${preset.name} did not make any tools available to this account. Connect again with access enabled.`);
    const current = connection.discovery;
    const result = await setRuntimeMcpEnablement(workspaceId, current.connectionId, current.connectionRevision,
      connection.tools.map((tool) => tool.name), current.enabledResources, current.capabilityBindings);
    if (!result) throw new Error("Could not finish connecting. Try again.");
    enabled = result;
  } finally { await connection.client.close().catch(() => undefined); }

  // Vercel exposes public documentation tools too. An authenticated account
  // read, performed automatically, distinguishes account access from discovery.
  if (preset.id === "vercel") {
    let verified: Awaited<ReturnType<typeof openConnectorTools>> | undefined;
    try {
      verified = await openConnectorTools(workspaceId, serverId);
      enabled = verified.discovery;
      // openConnectorTools performs the authenticated account check.
    } catch (error) {
      // A failed account check must not leave an apparently usable connection.
      await setRuntimeMcpEnablement(workspaceId, enabled.connectionId, enabled.connectionRevision, [], [], []).catch(() => undefined);
      throw error;
    } finally { await verified?.client.close().catch(() => undefined); }
  }
  if (!remoteConnectionReady(enabled)) throw new Error("Sign-in is incomplete. Connect again to restore access.");
  return enabled;
}

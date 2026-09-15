import type { ConnectorManifest } from "@fable/protocol";
import { remoteConnectors, remoteConnectorServerId } from "../components/marketplace/remote-connectors";

export const CONNECTOR_CONNECTIONS_CHANGED = "fable:connector-connections-changed";
interface RemoteConnectionState {
  launchReference: string;
  authorizationState?: string;
  credentialState?: string;
  healthState?: string;
  discoveryState: string;
  discoveredAt?: string;
  discoveredTools: string[];
  enabledTools: string[];
}

export function connectorConnectionsChanged(workspaceId: string) {
  window.dispatchEvent(new CustomEvent(CONNECTOR_CONNECTIONS_CHANGED, { detail: { workspaceId } }));
}

export function remoteConnectionReady(connection: RemoteConnectionState) {
  return connection.authorizationState === "authorized"
    && connection.credentialState === "available"
    && connection.healthState === "healthy"
    && connection.discoveryState === "discovered"
    && connection.enabledTools.some((tool) => connection.discoveredTools.includes(tool));
}

/** One route for setup, Installed, mentions and new turns. Prefer verified
 * remote access, but a broken saved setup must not hide a healthy native account.
 * In-flight turns retain their admitted route through the execution fence. */
export function mergeConnectorConnections(native: readonly ConnectorManifest[], remote: readonly RemoteConnectionState[]): ConnectorManifest[] {
  const manifests = new Map(native.map((manifest) => [manifest.id, { ...manifest, connectionRoute: "native" as const } as ConnectorManifest]));
  for (const preset of remoteConnectors) {
    const connection = remote.find((candidate) => candidate.launchReference === remoteConnectorServerId(preset.id));
    if (!connection) continue;
    const ready = remoteConnectionReady(connection);
    const existing = manifests.get(preset.id);
    const nativeReady = existing?.status === "connected"
      && existing.health?.state === "healthy"
      && !existing.scopes?.some((scope) => scope.required && !scope.granted);
    if (!ready && nativeReady) continue;
    const revoked = connection.authorizationState === "revoked";
    const summary = ready ? `${preset.name} is connected.` : revoked ? "Disconnected." : `Connect ${preset.name} to finish signing in or restore access.`;
    manifests.set(preset.id, {
      id: preset.id, name: preset.name, connectionRoute: "remote",
      status: ready ? "connected" : revoked ? "revoked" : "needs-auth",
      permissions: [], scopes: [], healthSummary: summary,
      lastCheckedAt: connection.discoveredAt ?? "", supportsSearch: ready,
      supportedActions: [], health: { state: ready ? "healthy" : "unknown", summary, checkedAt: connection.discoveredAt ?? "" },
    });
  }
  return [...manifests.values()];
}

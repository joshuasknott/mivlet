import type { ConnectorManifest } from "@mivlet/protocol";
import { remoteConnectors, remoteConnectorServerId } from "../components/marketplace/remote-connectors";
import { customMcpConnectorId } from "./custom-mcp";

export const CONNECTOR_CONNECTIONS_CHANGED = "mivlet:connector-connections-changed";
interface RemoteConnectionState {
  displayName?: string;
  launchReference: string;
  authorizationState?: string;
  credentialState?: string;
  healthState?: string;
  discoveryState: string;
  discoveredAt?: string;
  discoveredTools: string[];
  enabledTools: string[];
  discoveredResources?: string[];
  enabledResources?: string[];
}

export function connectorConnectionsChanged(workspaceId: string) {
  window.dispatchEvent(new CustomEvent(CONNECTOR_CONNECTIONS_CHANGED, { detail: { workspaceId } }));
}

export function remoteConnectionReady(connection: RemoteConnectionState) {
  return connection.authorizationState === "authorized"
    && connection.credentialState === "available"
    && connection.healthState === "healthy"
    && connection.discoveryState === "discovered"
    && (connection.enabledTools.some((tool) => connection.discoveredTools.includes(tool))
      || (connection.enabledResources ?? []).some(uri => connection.discoveredResources?.includes(uri)));
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
  for (const connection of remote) {
    const id = customMcpConnectorId(connection.launchReference);
    if (!id) continue;
    const access = connection.enabledTools.some(tool => connection.discoveredTools.includes(tool))
      || (connection.enabledResources ?? []).some(uri => connection.discoveredResources?.includes(uri));
    const authorized = (connection.authorizationState === "authorized" && connection.credentialState === "available")
      || (connection.authorizationState === "not-required" && connection.credentialState === "not-required");
    const ready = authorized && connection.healthState === "healthy" && connection.discoveryState === "discovered" && access;
    const name = connection.displayName || "Custom tool server";
    const summary = ready ? `${name} is connected.` : `Check ${name} and enable its access in Plugins.`;
    manifests.set(id, { id, name, connectionRoute: "mcp", status: ready ? "connected" : "needs-auth",
      permissions: [], scopes: [], healthSummary: summary, lastCheckedAt: connection.discoveredAt ?? "",
      supportsSearch: false, supportedActions: [], health: { state: ready ? "healthy" : "unknown", summary, checkedAt: connection.discoveredAt ?? "" } });
  }
  return [...manifests.values()];
}

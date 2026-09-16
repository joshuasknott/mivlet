import type { ConnectorManifest, NativeToolSpec } from "@mivlet/protocol";
import { registeredToolSpecs } from "@mivlet/connectors/native-api/tools";
import { remoteConnectorFor } from "../components/marketplace/remote-connectors";
import { tokenPluginFor } from "@mivlet/connectors/providers/token-plugins";

export const CONNECTOR_READ_TOOLS: Record<string, string> = {
  "google-drive-read": "google-drive",
  "gmail-read": "gmail",
  "google-calendar-read": "google-calendar",
  "github-read": "github",
  "vercel-read": "vercel",
  "linear-read": "linear",
  "search-notion": "notion",
  "search-slack": "slack",
};

export function chatConnectorIds(
  _savedRemoteIds: readonly string[],
  manifests: readonly ConnectorManifest[],
): string[] {
  return [...new Set(manifests.filter((connector) => connector.status === "connected").map((connector) => connector.id))];
}

export function chatConnectorTools(ids: readonly string[], manifests?: readonly ConnectorManifest[]): NativeToolSpec[] {
  const plugins = ids.map(tokenPluginFor).filter((plugin) => plugin && (!manifests || manifests.some((manifest) => manifest.id === plugin.id && manifest.status === "connected" && manifest.connectionRoute !== "remote")));
  const nativeIds = ids.filter((id) => Object.values(CONNECTOR_READ_TOOLS).includes(id)
    && (!manifests || manifests.some((manifest) => manifest.id === id && manifest.status === "connected" && manifest.connectionRoute !== "remote")));
  return registeredToolSpecs().filter((tool) => {
    if (tool.name === "plugin-read") return plugins.length > 0;
    if (tool.name === "connector-action") return manifests?.some((manifest) => nativeIds.includes(manifest.id) && manifest.supportedActions?.length) ?? false;
    const connectorId = CONNECTOR_READ_TOOLS[tool.name];
    return connectorId
      ? nativeIds.includes(connectorId)
      : (tool.name === "connector-tools" || tool.name === "connector-call") &&
          ids.some((id) => remoteConnectorFor(id) && !nativeIds.includes(id));
  }).map((tool) => tool.name === "plugin-read" ? { ...tool, description: `${tool.description} Available plugins and capabilities: ${plugins.map((plugin) => `${plugin!.id}: ${Object.entries(plugin!.capabilities).map(([name, help]) => `${name} (${help})`).join("; ")}`).join(". ")}.` } : tool.name === "connector-action" ? { ...tool, description: `${tool.description} Available actions: ${manifests?.filter((manifest) => nativeIds.includes(manifest.id)).flatMap((manifest) => manifest.supportedActions ?? []).join(", ")}.` } : tool.name === "connector-tools" ? { ...tool, description: `${tool.description} Workspace app IDs: ${ids.filter((id) => remoteConnectorFor(id) && !nativeIds.includes(id)).join(", ")}.` } : tool);
}

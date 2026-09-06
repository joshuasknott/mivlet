import type { ConnectorManifest, NativeToolSpec } from "@fable/protocol";
import { registeredToolSpecs } from "@fable/connectors/native-api/tools";
import { remoteConnectorFor } from "../components/marketplace/remote-connectors";

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
  savedRemoteIds: readonly string[],
  manifests: readonly ConnectorManifest[],
): string[] {
  const requested = new Set([...manifests.filter((connector) => connector.status === "connected").map((connector) => connector.id), ...savedRemoteIds]);
  return [...requested].filter(
    (id) =>
      manifests.some(
        (connector) => connector.id === id && connector.status === "connected",
      ) ||
      (savedRemoteIds.includes(id) && Boolean(remoteConnectorFor(id))),
  );
}

export function chatConnectorTools(ids: readonly string[], manifests?: readonly ConnectorManifest[]): NativeToolSpec[] {
  const nativeIds = ids.filter((id) => Object.values(CONNECTOR_READ_TOOLS).includes(id)
    && (!manifests || manifests.some((manifest) => manifest.id === id && manifest.status === "connected")));
  return registeredToolSpecs().filter((tool) => {
    if (tool.name === "connector-action") return manifests?.some((manifest) => nativeIds.includes(manifest.id) && manifest.supportedActions?.length) ?? false;
    const connectorId = CONNECTOR_READ_TOOLS[tool.name];
    return connectorId
      ? nativeIds.includes(connectorId)
      : (tool.name === "connector-tools" || tool.name === "connector-call") &&
          ids.some((id) => remoteConnectorFor(id) && !nativeIds.includes(id));
  }).map((tool) => tool.name === "connector-action" ? { ...tool, description: `${tool.description} Available actions: ${manifests?.filter((manifest) => nativeIds.includes(manifest.id)).flatMap((manifest) => manifest.supportedActions ?? []).join(", ")}.` } : tool.name === "connector-tools" ? { ...tool, description: `${tool.description} Workspace app IDs: ${ids.filter((id) => remoteConnectorFor(id) && !nativeIds.includes(id)).join(", ")}.` } : tool);
}

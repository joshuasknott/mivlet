import type { ApprovalGate } from "@mivlet/connectors";
import { openConnectorTools } from "./connector-mcp";
import { remoteConnectorFor, remoteConnectorServerId } from "../components/marketplace/remote-connectors";
import { customMcpServerReference } from "./custom-mcp";
import { assertConnectorToolSucceeded } from "./connector-errors";
import type { DesktopToolExecutorOptions } from "./desktop-tool-options";
import { runConnectedApp } from "./connected-app-cancellation";

function appResourceUri(tool: Record<string, unknown>): string | undefined {
  const meta = tool._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const ui = (meta as Record<string, unknown>).ui;
  const uri = ui && typeof ui === "object" && !Array.isArray(ui)
    ? (ui as Record<string, unknown>).resourceUri
    : (meta as Record<string, unknown>)["ui/resourceUri"];
  return typeof uri === "string" && uri.startsWith("ui://") && uri.length <= 2_048 && !/[\u0000-\u001f\u007f]/u.test(uri)
    ? uri
    : undefined;
}

export async function runOfficialConnector(
  gate: ApprovalGate, operation: string, parsed: Record<string, unknown>, options: DesktopToolExecutorOptions,
  checkProviderCall: () => Promise<void>,
): Promise<string> {
  const connectorId = typeof parsed.connectorId === "string" ? parsed.connectorId : "";
  const serverId = remoteConnectorFor(connectorId) ? remoteConnectorServerId(connectorId) : customMcpServerReference(connectorId);
  const accessCurrent = () => !options.shouldCancel?.() && Boolean(options.connectorAccessCurrent
    ? options.connectorAccessCurrent(connectorId) : options.connectorIds?.includes(connectorId));
  if (!options.workspaceId || !serverId || !accessCurrent()) {
    throw new Error("Connect this app in the workspace's Plugins page first.");
  }
  return runConnectedApp(options, accessCurrent, () => openConnectorTools(options.workspaceId!, serverId), async (connection, requireCurrent) => {
    requireCurrent();
    const enabledTools = connection.tools.filter((tool) => connection.discovery.enabledTools.includes(tool.name));
    if (operation === "connector-tools") {
      const resources = connection.resources.filter(resource => connection.discovery.enabledResources.includes(resource.uri));
      return JSON.stringify({ trust: "untrusted", instructionAuthority: "none", connectorId, tools: enabledTools, resources });
    }
    const toolName = typeof parsed.toolName === "string" ? parsed.toolName : "";
    const input = parsed.input;
    const uri = typeof parsed.uri === "string" ? parsed.uri : "";
    const resourceRead = operation === "connector-resource";
    if (resourceRead ? !connection.discovery.enabledResources.includes(uri) || !connection.resources.some(resource => resource.uri === uri)
      : !enabledTools.some((tool) => tool.name === toolName) || !input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Choose an enabled connector tool and supply its input object.");
    }
    const { proposal, prepared } = resourceRead ? await connection.transport.prepareResourceRead(uri)
      : await connection.transport.prepareToolCall(toolName, input as Record<string, unknown>);
    requireCurrent();
    // Only native policy can classify an exact official tool as a routine read.
    // Missing flags (including older runtimes) retain the approval requirement.
    if (prepared.requiresApproval !== false) {
      if (!options.queueApproval) throw new Error("Connector actions require the workspace approval panel.");
      options.queueApproval(prepared.approval, operation, JSON.stringify(resourceRead ? { connectorId, uri } : { connectorId, toolName, input }));
      if (await gate.waitForDecision(prepared.approval) !== "granted") throw new Error("Connector action was denied.");
    }
    requireCurrent();
    const permit = await connection.transport.authorizeToolCall(proposal, { request: prepared.approval, decision: "once", decidedAt: new Date().toISOString() });
    requireCurrent();
    await checkProviderCall();
    requireCurrent();
    const result = await connection.transport.executeAuthorizedToolCall(proposal, permit.permitId);
    requireCurrent();
    assertConnectorToolSucceeded(result);
    // Keep the app descriptor alongside the bounded, untrusted result so a
    // saved conversation can reopen the UI without another model call. The
    // descriptor never contains credentials or arbitrary server metadata.
    const resourceUri = resourceRead ? undefined : appResourceUri(
      enabledTools.find((candidate) => candidate.name === toolName) as unknown as Record<string, unknown>,
    );
    return JSON.stringify(resourceUri && result && typeof result === "object" && !Array.isArray(result)
      ? { ...(result as Record<string, unknown>), mcpApp: { connectorId, toolName, resourceUri } }
      : result);
  });
}

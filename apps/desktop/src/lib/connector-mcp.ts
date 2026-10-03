import { McpClient } from "./native-mcp-client";
import { createDesktopMcpTransport, createDesktopRemoteMcpTransport } from "./mcp-transport";
import { assertConnectorToolSucceeded } from "./connector-errors";
import { listRuntimeMcpServerConfigurations } from "../runtime/domains/mcp";
import { customMcpConnectorId } from "./custom-mcp";

/** Each use rediscovers against the current native Connection revision. */
export async function openConnectorTools(workspaceId: string, serverId: string) {
  let stdio = false;
  if (customMcpConnectorId(serverId)) {
    const server = (await listRuntimeMcpServerConfigurations(workspaceId))?.find(server => server.id === serverId && server.workspaceId === workspaceId && !server.disabled);
    if (!server) throw new Error("This custom tool server is unavailable. Check it in Plugins.");
    stdio = server.transport === "stdio";
  } else if (!serverId.startsWith("marketplace-")) {
    throw new Error("The tool server reference is invalid.");
  }
  const transport = stdio ? await createDesktopMcpTransport(workspaceId, serverId) : await createDesktopRemoteMcpTransport(workspaceId, serverId);
  if (!transport) throw new Error("Plugins require the desktop app.");
  const client = new McpClient(transport);
  try {
    const initialized = await client.initialize();
    const tools = initialized.capabilities.tools ? await client.listTools() : [];
    const resources = initialized.capabilities.resources ? await client.listResources() : [];
    const discovery = await transport.recordDiscovery(tools.map((tool) => tool.name), resources.map((resource) => resource.uri));
    // Public Vercel discovery alone says nothing about authenticated account
    // access. Existing installations receive the same automatic check as setup.
    if (serverId === "marketplace-vercel" && (discovery.enabledTools.length || discovery.enabledResources?.length)) {
      if (!discovery.enabledTools.includes("list_teams")) throw new Error("Reconnect Vercel to grant account access.");
      const { proposal, prepared } = await transport.prepareToolCall("list_teams", {});
      if (prepared.requiresApproval !== false) throw new Error("Could not verify Vercel account access. Reconnect Vercel.");
      const permit = await transport.authorizeToolCall(proposal, {
        request: prepared.approval, decision: "once", decidedAt: new Date().toISOString(),
      });
      assertConnectorToolSucceeded(await transport.executeAuthorizedToolCall(proposal, permit.permitId));
    }
    return { transport, client, tools, resources, discovery };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

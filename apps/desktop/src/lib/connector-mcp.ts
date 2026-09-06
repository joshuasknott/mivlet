import { McpClient } from "@fable/connectors/mcp/client";
import { createDesktopRemoteMcpTransport } from "./mcp-transport";

/** Each use rediscovers against the current native Connection revision. */
export async function openConnectorTools(workspaceId: string, serverId: string) {
  const transport = await createDesktopRemoteMcpTransport(workspaceId, serverId);
  if (!transport) throw new Error("Connectors require the desktop app.");
  const client = new McpClient(transport, { authorizeToolCall: async () => false });
  try {
    const initialized = await client.initialize();
    const tools = initialized.capabilities.tools ? await client.listTools() : [];
    const resources = initialized.capabilities.resources ? await client.listResources() : [];
    const discovery = await transport.recordDiscovery(tools.map((tool) => tool.name), resources.map((resource) => resource.uri));
    return { transport, client, tools, discovery };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

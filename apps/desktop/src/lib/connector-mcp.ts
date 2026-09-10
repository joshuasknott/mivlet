import { McpClient } from "./native-mcp-client";
import { createDesktopRemoteMcpTransport } from "./mcp-transport";
import { assertConnectorToolSucceeded } from "./connector-errors";

/** Each use rediscovers against the current native Connection revision. */
export async function openConnectorTools(workspaceId: string, serverId: string) {
  const transport = await createDesktopRemoteMcpTransport(workspaceId, serverId);
  if (!transport) throw new Error("Plugins require the desktop app.");
  const client = new McpClient(transport);
  try {
    const initialized = await client.initialize();
    const tools = initialized.capabilities.tools ? await client.listTools() : [];
    const resources = initialized.capabilities.resources ? await client.listResources() : [];
    const discovery = await transport.recordDiscovery(tools.map((tool) => tool.name), resources.map((resource) => resource.uri));
    // Public Vercel discovery alone says nothing about authenticated account
    // access. Existing installations receive the same automatic check as setup.
    if (serverId === "marketplace-vercel" && discovery.enabledTools.length) {
      if (!discovery.enabledTools.includes("list_teams")) throw new Error("Reconnect Vercel to grant account access.");
      const { proposal, prepared } = await transport.prepareToolCall("list_teams", {});
      if (prepared.requiresApproval !== false) throw new Error("Could not verify Vercel account access. Reconnect Vercel.");
      const permit = await transport.authorizeToolCall(proposal, {
        request: prepared.approval, decision: "once", decidedAt: new Date().toISOString(),
        confirmationText: prepared.approval.confirmationPhrase,
      });
      assertConnectorToolSucceeded(await transport.executeAuthorizedToolCall(proposal, permit.permitId));
    }
    return { transport, client, tools, discovery };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

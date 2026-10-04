/** Load native MCP transport only when a connection is opened. */
import type { DesktopMcpTransportHandle } from "./mcp-transport-contract";
export type { DesktopMcpTransportHandle } from "./mcp-transport-contract";

export async function createDesktopMcpTransport(workspaceId: string, launchReference: string): Promise<DesktopMcpTransportHandle | null> {
  const transport = await import("./mcp-transport-core");
  return transport.createDesktopMcpTransport(workspaceId, launchReference);
}

export async function createDesktopRemoteMcpTransport(workspaceId: string, configurationReference: string): Promise<DesktopMcpTransportHandle | null> {
  const transport = await import("./mcp-transport-core");
  return transport.createDesktopRemoteMcpTransport(workspaceId, configurationReference);
}

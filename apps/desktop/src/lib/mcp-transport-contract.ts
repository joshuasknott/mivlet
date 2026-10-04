import type { McpTransport } from "@mivlet/connectors";
import type { ApprovalResolutionRequest } from "@mivlet/protocol";
import type { RuntimeAuthorizedMcpToolCall, RuntimeMcpConnectionDetails, RuntimeMcpToolProposal, RuntimePreparedMcpToolCall } from "../runtime/domains/mcp";

export interface DesktopMcpTransportHandle extends McpTransport {
  readonly sessionId: string;
  prepareResourceRead(uri: string): ReturnType<DesktopMcpTransportHandle["prepareToolCall"]>;
  recordDiscovery(tools: string[], resources: string[]): Promise<RuntimeMcpConnectionDetails>;
  prepareToolCall(toolName: string, args: Record<string, unknown>): Promise<{
    proposal: RuntimeMcpToolProposal;
    prepared: RuntimePreparedMcpToolCall;
  }>;
  authorizeToolCall(
    proposal: RuntimeMcpToolProposal,
    resolution: ApprovalResolutionRequest
  ): Promise<RuntimeAuthorizedMcpToolCall>;
  executeAuthorizedToolCall(
    proposal: RuntimeMcpToolProposal,
    permitId: string
  ): Promise<unknown>;
}

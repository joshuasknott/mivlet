import { runConnectedApp } from "./connected-app-cancellation";
import { normalizeMcpConnectedSourceSearch, type McpUntrustedToolResult } from "@mivlet/connectors";
import type { RuntimeResolvedMcpCapabilityRoute, RuntimeMcpToolProposal } from "../runtime/domains/mcp";
import type { DesktopToolExecutorOptions } from "./desktop-tool-options";
import { McpClient } from "./native-mcp-client";
import { createDesktopMcpTransport, createDesktopRemoteMcpTransport } from "./mcp-transport";

interface McpSemanticContinuation {
  kind: "mcp-connected-source-search";
  proposal: RuntimeMcpToolProposal;
  permitId: string;
  workspaceId: string;
  query: string;
  connectionId: string;
  matchedGrantIds: string[];
  degraded: boolean;
  degradationReasons: string[];
}

function parseMcpContinuation(value: string): McpSemanticContinuation {
  const parsed = JSON.parse(value) as Partial<McpSemanticContinuation>;
  if (
    parsed.kind !== "mcp-connected-source-search" ||
    !parsed.proposal ||
    typeof parsed.permitId !== "string" ||
    typeof parsed.workspaceId !== "string" ||
    typeof parsed.query !== "string" ||
    typeof parsed.connectionId !== "string" ||
    !Array.isArray(parsed.matchedGrantIds) ||
    typeof parsed.degraded !== "boolean" ||
    !Array.isArray(parsed.degradationReasons)
  ) {
    throw new Error("Mivlet returned an invalid MCP semantic continuation.");
  }
  return parsed as McpSemanticContinuation;
}

export async function runMcpSemanticRead(
  options: DesktopToolExecutorOptions,
  route: RuntimeResolvedMcpCapabilityRoute,
  executeNative: (sessionId: string) => Promise<string>,
): Promise<string> {
  const workspaceId = options.workspaceId;
  if (!workspaceId) throw new Error("MCP semantic search requires an active workspace.");
  return runConnectedApp(options, () => !options.shouldCancel?.(), async () => {
    const transport = route.transport === "stdio"
      ? await createDesktopMcpTransport(workspaceId, route.configurationReference)
      : await createDesktopRemoteMcpTransport(workspaceId, route.configurationReference);
    if (!transport) throw new Error("MCP semantic search requires the desktop runtime.");
    return { client: transport };
  }, async ({ client: transport }, requireCurrent) => {
    const client = new McpClient(transport);
    const initialized = await client.initialize();
    const tools = initialized.capabilities.tools ? await client.listTools() : [];
    const resources = initialized.capabilities.resources ? await client.listResources() : [];
    const discovery = await transport.recordDiscovery(
      tools.map((tool) => tool.name),
      resources.map((resource) => resource.uri)
    );
    const binding = discovery.capabilityBindings.find(
      (candidate) => candidate.capabilityId === "knowledge.content.search"
    );
    if (!binding || binding.toolName !== route.toolName) {
      throw new Error("The MCP connected-source binding changed during discovery.");
    }
    requireCurrent();
    const prepared = await executeNative(transport.sessionId);
    const continuation = parseMcpContinuation(prepared);
    requireCurrent();
    const untrusted = await transport.executeAuthorizedToolCall(
      continuation.proposal,
      continuation.permitId
    ) as McpUntrustedToolResult;
    const result = normalizeMcpConnectedSourceSearch(untrusted, {
      workspaceId: continuation.workspaceId,
      query: continuation.query,
      connectionId: continuation.connectionId,
      matchedGrantIds: continuation.matchedGrantIds,
      degraded: continuation.degraded,
      degradationReasons: continuation.degradationReasons
    });
    return JSON.stringify({
      capabilityId: "knowledge.content.search",
      availability: continuation.degraded ? "degraded" : "available",
      connectionId: continuation.connectionId,
      connectorId: "mcp",
      implementationEvidence: "adapter-validated",
      matchedGrantIds: continuation.matchedGrantIds,
      result
    });
  });
}

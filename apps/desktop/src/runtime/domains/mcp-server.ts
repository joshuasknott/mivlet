import type {
  McpConsentDecision,
  McpServerConfig,
  McpServerStatus,
} from "@mivlet/protocol/domains/mcp-server";
import { getRuntimeAdapter } from "../adapters/select";
import { toRuntimeError } from "../errors";

async function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const adapter = getRuntimeAdapter();
  if (adapter.kind !== "native")
    throw new Error(
      "External assistants require the signed-in Mivlet desktop app.",
    );
  try {
    return await adapter.invoke<T>(command, args);
  } catch (error) {
    throw toRuntimeError(error);
  }
}
export const getMcpServerStatus = () =>
  invoke<McpServerStatus>("mcp_server_status");
export const startMcpServer = (config: McpServerConfig) =>
  invoke<void>("mcp_server_start", { config });
export const stopMcpServer = () => invoke<void>("mcp_server_stop");
export const decideMcpClient = (decision: McpConsentDecision) =>
  invoke<void>("mcp_server_decide", { decision });
export const revokeMcpClient = (grantId: string) =>
  invoke<void>("mcp_server_revoke", { grantId });
export const onMcpWorkChanged = (changed: () => void) =>
  getRuntimeAdapter().listen<void>("mivlet-mcp-changed", changed);

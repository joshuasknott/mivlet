import type {
  McpConsentDecision,
  McpServerConfig,
  McpServerStatus,
} from "@mivlet/protocol";
import { getRuntimeAdapter } from "../adapters/select";
import { invokeRequiredNative } from "../required-native";

const invoke = <T>(command: string, args?: Record<string, unknown>) =>
  invokeRequiredNative<T>(
    command,
    args,
    "External assistants require the signed-in Mivlet desktop app.",
  );
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

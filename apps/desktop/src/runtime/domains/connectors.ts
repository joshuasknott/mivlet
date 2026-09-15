import { mergeConnectorConnections } from "../../lib/connector-connections";
import { toRuntimeError } from "../errors";
import type {
  ApprovalResolutionRequest,
  ConnectorActionRequest,
  ConnectorActionResult,
  ConnectorAccountOption,
  ConnectorAuthRequest,
  ConnectorAuthResult,
  ConnectorManifest,
  ConnectorSyncRequest,
  ConnectorSyncState,
  KnowledgeSource,
} from "@fable/protocol";
import {
  hasTauriRuntime,
  invoke,
  invokeNative,
  activeDataScope,
} from "../bridge";
import type { RuntimeMcpConnectionDetails } from "./mcp";

// Native commands own credentials and connection health. Preview calls return
// null rather than claiming a live connection.

export async function listRuntimeConnectorStatuses() {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    const [native, remote] = await Promise.all([
      invoke<ConnectorManifest[]>("list_connector_statuses", scope),
      invoke<RuntimeMcpConnectionDetails[]>(
        "list_remote_mcp_connections",
        scope,
      ),
    ]);
    // Finish verification automatically for accounts connected by an older
    // build. A user never needs to find or press a separate test button.
    const verifiedNative = await Promise.all(
      native.map(async (connector) => {
        if (
          connector.status !== "connected" ||
          connector.health?.state !== "unknown"
        )
          return connector;
        try {
          return await invoke<ConnectorManifest>("refresh_connector_health", {
            ...scope,
            connectorId: connector.id,
          });
        } catch {
          return {
            ...connector,
            status: "provider-error" as const,
            healthSummary: "Could not finish connecting. Try again.",
          };
        }
      }),
    );
    return mergeConnectorConnections(verifiedNative, remote);
  } catch {
    return null;
  }
}

export async function connectRuntimeTokenPlugin(
  workspaceId: string,
  connectorId: string,
  credential: {
    token: string;
    baseUrl?: string;
    accountId?: string;
    developerToken?: string;
    loginCustomerId?: string;
  },
): Promise<ConnectorManifest> {
  if (!hasTauriRuntime())
    throw new Error("Open the Mivlet desktop app to connect this plugin.");
  const scope = activeDataScope();
  if (!scope || scope.workspaceId !== workspaceId)
    throw new Error("Select the active workspace before connecting.");
  try {
    return await invoke<ConnectorManifest>("connect_token_plugin", {
      workspaceId,
      connectorId,
      credential,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

/**
 * Begin an end-to-end loopback OAuth flow. Rust binds a redirect URI, starts
 * the transaction, opens the browser, accepts one callback, and completes the
 * token exchange inside the credential boundary. Confidential providers route
 * exchange through the configured auth broker; public Google clients call
 * Google directly. Returns null outside Tauri.
 */
export async function beginRuntimeConnectorOAuth(
  request: ConnectorAuthRequest,
) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorAuthResult>("begin_connector_oauth", {
      request,
      workspaceId: scope.workspaceId,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function clearRuntimeConnectorAuth(connectorId: string) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorManifest>("clear_connector_auth", {
      connectorId,
      workspaceId: scope.workspaceId,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function listRuntimeConnectorAccounts(connectorId: string) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorAccountOption[]>("list_connector_accounts", {
      connectorId,
      workspaceId: scope.workspaceId,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function switchRuntimeConnectorAccount(
  connectorId: string,
  connectionId: string,
) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorManifest>("switch_connector_account", {
      connectorId,
      connectionId,
      workspaceId: scope.workspaceId,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function refreshRuntimeConnectorHealth(connectorId: string) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorManifest>("refresh_connector_health", {
      connectorId,
      workspaceId: scope.workspaceId,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function listRuntimeConnectorSyncStates(
  workspaceId = activeDataScope()?.workspaceId,
) {
  if (!hasTauriRuntime()) {
    return null;
  }
  if (!workspaceId) return null;
  try {
    return await invoke<ConnectorSyncState[]>("list_connector_sync_states", {
      workspaceId,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function syncRuntimeConnector(request: ConnectorSyncRequest) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope || request.workspaceId !== scope.workspaceId) return null;
  try {
    return await invoke<ConnectorSyncState>("sync_connector", { request });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

async function invokeConnectorKnowledge<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T | null> {
  if (!hasTauriRuntime()) return null;
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<T>(command, {
      ...args,
      ...scope,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export function listRuntimeConnectorKnowledgeSources() {
  return invokeConnectorKnowledge<KnowledgeSource[]>(
    "list_connector_knowledge_sources",
  );
}

export async function prepareRuntimeConnectorToolAction(
  workspaceId: string,
  connectorId: string,
  action: string,
  payload: Record<string, string>,
) {
  return invokeNative<{
    action: ConnectorActionRequest;
    preview: string;
    connectionId?: string | null;
  }>(
    "prepare_connector_tool_action",
    { workspaceId, connectorId, action, payload },
  );
}

export async function executeRuntimeConnectorAction(request: {
  action: ConnectorActionRequest;
  approval: ApprovalResolutionRequest;
}) {
  if (!hasTauriRuntime()) {
    return null;
  }
  const scope = activeDataScope();
  if (!scope) return null;
  try {
    return await invoke<ConnectorActionResult>(
      "execute_approved_connector_action",
      {
        request,
        workspaceId: scope.workspaceId,
      },
    );
  } catch (error) {
    throw toRuntimeError(error);
  }
}

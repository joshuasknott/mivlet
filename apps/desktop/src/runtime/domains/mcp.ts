import { toRuntimeError } from "../errors";
import {
  CONNECTED_SOURCE_SEARCH_CONTRACT_VERSION,
  type ApprovalResolutionRequest,
} from "@mivlet/protocol";
import { hasTauriRuntime, invoke, invokeNative, listen } from "../bridge";

// Authenticated provider composition. These wrappers carry only prompt content and
// opaque event identities; Rust derives account, workspace, member, actor,
// authority, revisions, timestamps, evaluation, and terminal results.
export interface RuntimeSpawnedMcpProcess {
  sessionId: string;
  channel: string;
  launchReference: string;
  connectionId: string;
  connectionRevision: number;
}

export interface RuntimeMcpConnectionDetails {
  connectionId: string;
  connectionRevision: number;
  displayName?: string;
  authorizationState?: string;
  credentialState?: string;
  healthState?: string;
  transport: "stdio" | "streamable-http";
  launchReference: string;
  discoveryState: string;
  discoveredAt?: string;
  discoveredTools: string[];
  discoveredResources: string[];
  enabledTools: string[];
  enabledResources: string[];
  capabilityBindings: Array<{
    capabilityId: "knowledge.content.search";
    toolName: string;
    contractVersion: typeof CONNECTED_SOURCE_SEARCH_CONTRACT_VERSION;
    consequence: "read";
    trust: "untrusted";
  }>;
}

export interface RuntimeResolvedMcpCapabilityRoute {
  configurationReference: string;
  transport: "stdio" | "streamable-http";
  connectionId: string;
  connectionRevision: number;
  capabilityId: "knowledge.content.search";
  toolName: string;
}

export async function resolveRuntimeMcpCapabilityRoute(
  workspaceId: string,
  capabilityId: string,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeResolvedMcpCapabilityRoute | null>(
    "resolve_mcp_capability_route",
    {
      request: { workspaceId, capabilityId },
    },
  ).catch((error) => {
    throw toRuntimeError(error);
  });
}

export interface RuntimeMcpToolProposal {
  workspaceId: string;
  sessionId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface RuntimePreparedMcpToolCall {
  proposalFingerprint: string;
  requiresApproval?: boolean;
  approval: import("@mivlet/protocol").ApprovalRequest;
}

export interface RuntimeAuthorizedMcpToolCall {
  permitId: string;
  expiresInSeconds: number;
}

export interface RuntimeMcpServerConfiguration {
  workspaceId: string;
  id: string;
  displayName: string;
  transport: "stdio" | "streamable-http";
  command?: string;
  args?: string[];
  endpoint?: string;
  expectedRevision?: number;
}

export interface RuntimeMcpServerSummary {
  id: string;
  workspaceId: string;
  displayName: string;
  transport: "stdio" | "streamable-http";
  revision: number;
  disabled: boolean;
  createdByInternalUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimePreparedMcpServerConfiguration {
  configurationFingerprint: string;
  approval: import("@mivlet/protocol").ApprovalRequest;
}

export interface RuntimeCapabilityGrantProposal {
  workspaceId: string;
  capabilityId: string;
  connectionId?: string;
  maxUses?: number;
  expiresAt?: string;
}

export interface RuntimeCapabilityGrant {
  id: string;
  capabilityId: string;
  connectionId: string;
  consequence: string;
  scopeKind: "workspace";
  workspaceId: string;
  state: "active" | "suspended" | "expired" | "revoked";
  maxUses?: number;
  usesConsumed: number;
  expiresAt?: string;
  approvalRequirement: "required-for-every-action";
  revision: number;
  grantedAt: string;
  updatedAt: string;
}

export type RuntimePreparedCapabilityGrant =
  | { status: "granted"; grant: RuntimeCapabilityGrant }
  | {
      status: "confirmation-required";
      proposalFingerprint: string;
      target: {
        capabilityId: string;
        connectionId: string;
        connectionRevision: number;
        connectionDisplayName: string;
        consequence: string;
        availability: string;
      };
      approval: import("@mivlet/protocol").ApprovalRequest;
    };

export async function prepareRuntimeCapabilityGrant(
  proposal: RuntimeCapabilityGrantProposal,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimePreparedCapabilityGrant>("prepare_capability_grant", {
    proposal,
  }).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function commitRuntimeCapabilityGrant(
  proposal: RuntimeCapabilityGrantProposal,
  resolution: ApprovalResolutionRequest,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeCapabilityGrant>("commit_capability_grant", {
    request: { proposal, resolution },
  }).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function prepareRuntimeMcpServerConfiguration(
  configuration: RuntimeMcpServerConfiguration,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimePreparedMcpServerConfiguration>(
    "prepare_mcp_server_configuration",
    {
      configuration,
    },
  ).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function commitRuntimeMcpServerConfiguration(
  configuration: RuntimeMcpServerConfiguration,
  resolution: ApprovalResolutionRequest,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeMcpServerSummary>("commit_mcp_server_configuration", {
    request: { configuration, resolution },
  }).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function listRuntimeMcpServerConfigurations(workspaceId: string) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeMcpServerSummary[]>("list_mcp_server_configurations", {
    workspaceId,
  }).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function spawnRuntimeMcpProcess(
  workspaceId: string,
  launchReference: string,
) {
  return invokeNative<RuntimeSpawnedMcpProcess>("spawn_mcp_process", {
    request: { workspaceId, launchReference },
  });
}

export interface RuntimeOpenedRemoteMcpSession {
  sessionId: string;
  configurationReference: string;
  connectionId: string;
  connectionRevision: number;
}

export interface RuntimeRemoteMcpAuthorizationSummary {
  issuer: string;
  scopes: string[];
  pkceMethod: "S256";
  clientIdMetadataDocumentSupported: boolean;
  dynamicRegistrationSupported: boolean;
  clientRegistrationStrategy:
    | "pre-registered"
    | "client-id-metadata-document"
    | "dynamic-client-registration"
    | "manual-client-information";
  clientRegistrationStatus: "selected" | "configuration-required";
  clientRegistrationReason: string;
}

export interface RuntimeRemoteMcpAuthorizationResult {
  status: "connected";
  issuer: string;
  scopes: string[];
  clientRegistrationStrategy: RuntimeRemoteMcpAuthorizationSummary["clientRegistrationStrategy"];
  message: string;
}

export async function inspectRuntimeRemoteMcpAuthorization(
  workspaceId: string,
  configurationReference: string,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeRemoteMcpAuthorizationSummary>(
    "inspect_remote_mcp_authorization",
    {
      request: { workspaceId, configurationReference },
    },
  ).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function beginRuntimeRemoteMcpAuthorization(
  workspaceId: string,
  configurationReference: string,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeRemoteMcpAuthorizationResult>(
    "begin_remote_mcp_authorization",
    {
      request: { workspaceId, configurationReference },
    },
  ).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function disconnectRuntimeRemoteMcpAuthorization(
  workspaceId: string,
  configurationReference: string,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<{ status: "disconnected"; message: string }>(
    "disconnect_remote_mcp_authorization",
    { request: { workspaceId, configurationReference } },
  ).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function openRuntimeRemoteMcpSession(
  workspaceId: string,
  configurationReference: string,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeOpenedRemoteMcpSession>("open_remote_mcp_session", {
    request: { workspaceId, configurationReference },
  }).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function sendRuntimeRemoteMcpFrame(
  workspaceId: string,
  sessionId: string,
  frame: string,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<string[]>("send_remote_mcp_frame", {
    request: { workspaceId, sessionId, frame },
  }).catch((error) => {
    throw toRuntimeError(error);
  });
}

export interface RuntimeRemoteMcpPollResult {
  supported: boolean;
  frames: string[];
  retryAfterMs: number;
}

export async function pollRuntimeRemoteMcpMessages(
  workspaceId: string,
  sessionId: string,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<RuntimeRemoteMcpPollResult>("poll_remote_mcp_messages", {
    request: { workspaceId, sessionId },
  }).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function closeRuntimeRemoteMcpSession(
  workspaceId: string,
  sessionId: string,
) {
  if (!hasTauriRuntime()) return null;
  return invoke<null>("close_remote_mcp_session", {
    request: { workspaceId, sessionId },
  }).catch((error) => {
    throw toRuntimeError(error);
  });
}

export async function writeRuntimeMcpFrame(
  workspaceId: string,
  sessionId: string,
  frame: string,
) {
  return invokeNative<null>("write_mcp_frame", {
    request: { workspaceId, sessionId, frame },
  });
}

export async function closeRuntimeMcpProcess(
  workspaceId: string,
  sessionId: string,
) {
  return invokeNative<null>("close_mcp_process", {
    request: { workspaceId, sessionId },
  });
}

export async function recordRuntimeMcpDiscovery(
  workspaceId: string,
  sessionId: string,
  tools: string[],
  resources: string[],
) {
  return invokeNative<RuntimeMcpConnectionDetails>(
    "record_mcp_server_discovery",
    {
      request: { workspaceId, sessionId, tools, resources },
    },
  );
}

export async function setRuntimeMcpEnablement(
  workspaceId: string,
  connectionId: string,
  expectedRevision: number,
  enabledTools: string[],
  enabledResources: string[],
  capabilityBindings: Array<{
    capabilityId: "knowledge.content.search";
    toolName: string;
  }>,
) {
  return invokeNative<RuntimeMcpConnectionDetails>(
    "set_mcp_server_enablement",
    {
      request: {
        workspaceId,
        connectionId,
        expectedRevision,
        enabledTools,
        enabledResources,
        capabilityBindings,
      },
    },
  );
}

export async function prepareRuntimeMcpToolCall(
  proposal: RuntimeMcpToolProposal,
) {
  return invokeNative<RuntimePreparedMcpToolCall>("prepare_mcp_tool_call", {
    proposal,
  });
}

export async function authorizeRuntimeMcpToolCall(
  proposal: RuntimeMcpToolProposal,
  resolution: ApprovalResolutionRequest,
) {
  return invokeNative<RuntimeAuthorizedMcpToolCall>("authorize_mcp_tool_call", {
    request: { proposal, resolution },
  });
}

export async function executeRuntimeApprovedMcpToolCall(
  proposal: RuntimeMcpToolProposal,
  permitId: string,
  requestId: string,
) {
  return invokeNative<string[]>("execute_approved_mcp_tool_call", {
    request: { proposal, permitId, requestId },
  });
}

export async function listenRuntimeMcpFrames(
  channel: string,
  onFrame: (line: string) => void,
) {
  if (!hasTauriRuntime()) return null;
  if (!/^mivlet:\/\/mcp\/mcp-[0-9a-f]{32}$/.test(channel)) {
    throw new Error("The MCP event channel is invalid.");
  }
  try {
    return await listen<string>(channel, (event) => onFrame(event.payload));
  } catch {
    return null;
  }
}

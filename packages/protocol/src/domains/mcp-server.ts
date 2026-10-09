/** Inbound client administration. Credentials never cross this contract. */
export type McpClientAccess = "read-only" | "request-tasks";
export interface McpServerConfig {
  port: number;
  publicOrigin?: string;
  browserOrigins: string[];
}
export interface McpConsentRequest {
  id: string;
  clientName: string;
  redirectUri: string;
  requestedAccess: McpClientAccess;
  expiresAt: number;
}
export interface McpClientGrant {
  id: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  resource: string;
  workspaceId: string;
  agentIds: string[];
  workIds: string[];
  access: McpClientAccess;
  permissionMode: string;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
}
export interface McpConsentDecision {
  requestId: string;
  approve: boolean;
  workspaceId: string;
  agentIds: string[];
  workIds: string[];
  access: McpClientAccess;
  lifetimeHours: number;
}
export interface McpServerStatus {
  endpoint?: string | null;
  pending: McpConsentRequest[];
  grants: McpClientGrant[];
  history: {
    at: number;
    clientId: string;
    operation: string;
    target?: string | null;
    outcome: string;
  }[];
  shareableWork: {
    id: string;
    agentId: string;
    agentName: string;
    request: string;
    status: string;
  }[];
}

import type { ApprovalResolutionRequest } from "./approvals.js";
import type { CollaborationSnapshot } from "./collaboration.js";
import type { LocalProject } from "./local-projects.js";
import type { MivletAgentProfile } from "./agent-profile.js";

/** Model-facing tool names for durable local workspace lifecycle changes. */
export type WorkspaceManagementTool =
  | "workspace-inspect"
  | "agent-create"
  | "agent-update"
  | "agent-delete"
  | "project-create"
  | "project-team-update";

/** Stable operation labels used in receipts; derived from the exact tool name. */
export type WorkspaceManagementOperation =
  | "inspect"
  | "create-agent"
  | "update-agent"
  | "delete-agent"
  | "create-project"
  | "update-team";

/** Exact native request envelope for one approved workspace-management call. */
export interface WorkspaceManageRequest {
  workspaceId: string;
  workId: string;
  generation: number;
  runId: string;
  callId: string;
  tool: WorkspaceManagementTool;
  /** Raw model JSON arguments; native parses and re-canonicalizes them for exact approval binding. */
  arguments: string;
  approval: ApprovalResolutionRequest;
  /** CAS fence for agent profile mutations; omitted for inspect/project actions. */
  expectedAgentRevision?: number;
}

export interface WorkspaceManageReceipt {
  id: string;
  operation: WorkspaceManagementOperation;
  summary: string;
  replayed: boolean;
  agentId?: string;
  projectId?: string;
}

/** Safe result returned by native workspace management. Full private profiles
 * remain renderer state; the model should receive only the bounded receipt. */
export interface WorkspaceManageResponse {
  agents: MivletAgentProfile[];
  agentRevision: number;
  activeAgentId?: string;
  collaboration: CollaborationSnapshot;
  projects: LocalProject[];
  receipt: WorkspaceManageReceipt;
}

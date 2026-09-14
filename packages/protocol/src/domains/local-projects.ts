/** A member-private room whose ordinary conversation is shared by local agents. */
export interface LocalProject {
  id: string;
  workspaceId: string;
  name: string;
  instructions: string;
  knowledgeSourceIds: string[];
  /** Explicit, inspectable shares recorded by the user or a participant agent. */
  shares: ProjectContextShare[];
  threadId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

/** Explicit sharing never conveys tool authority. Snapshots retain the exact
 * selected bytes; live references resolve again under the current account on
 * each deliberate use and can become unavailable. */
export type ProjectShareMode = "snapshot" | "live-reference";
export type ProjectShareSourceKind =
  | "file"
  | "work"
  | "artifact"
  | "conversation"
  | "message"
  | "memory";

export interface ProjectShareSource {
  workspaceId: string;
  kind: ProjectShareSourceKind;
  id: string;
}

export interface ProjectShareRecipient {
  kind: "project" | "agent";
  id: string;
}

export interface ProjectShareOwner {
  kind: "user" | "agent";
  /** Durable agent id for agent owners; never inferred from a display name. */
  id?: string;
  name: string;
}

export interface ProjectContextShare {
  id: string;
  projectId: string;
  mode: ProjectShareMode;
  source: ProjectShareSource;
  /** The source revision frozen at share time for snapshots, or the observed
   * revision for a live reference. */
  sourceRevision: string;
  recipient: ProjectShareRecipient;
  owner: ProjectShareOwner;
  /** Best-effort display title captured at share time. */
  title: string;
  /** Snapshot bytes only. Live references never copy source content. */
  snapshotText?: string;
  createdAt: string;
}

export interface CreateLocalProjectInput {
  workspaceId: string;
  id: string;
  threadId: string;
  name: string;
  instructions: string;
  knowledgeSourceIds: string[];
}

export interface UpdateLocalProjectInput {
  workspaceId: string;
  id: string;
  expectedRevision: number;
  name: string;
  instructions: string;
  knowledgeSourceIds: string[];
}

export interface AddProjectContextShareInput {
  workspaceId: string;
  projectId: string;
  expectedRevision: number;
  share: {
    mode: ProjectShareMode;
    source: ProjectShareSource;
    sourceRevision: string;
    recipient: ProjectShareRecipient;
    owner: ProjectShareOwner;
    title: string;
    snapshotText?: string;
  };
}

export interface RemoveProjectContextShareInput {
  workspaceId: string;
  projectId: string;
  expectedRevision: number;
  shareId: string;
}

export interface MigrateLegacyGroupInput {
  workspaceId: string;
  /** New project id. */
  id: string;
  /** The legacy standalone group conversation id, which is also its thread. */
  conversationId: string;
  expectedRevision: number;
  name: string;
  instructions: string;
  participantIds: string[];
  /** Optional coordinator; must be a current participant when present. */
  leadAgentId?: string;
  /** Existing history is shared with the new project; migration never deletes it. */
  shareHistory: true;
}

export interface BindLocalProjectRunAuthorInput {
  workspaceId: string;
  projectId: string;
  expectedRevision: number;
  runId: string;
  agentId: string;
  threadId: string;
}

export interface LocalProjectRunAuthor {
  projectId: string;
  runId: string;
  agentId: string;
  /** Derived from the current persisted agent profile at native bind time. */
  agentName: string;
  threadId: string;
  createdAt: string;
}

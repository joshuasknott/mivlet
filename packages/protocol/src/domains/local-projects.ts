/** A member-private room whose ordinary conversation is shared by local agents. */
export interface LocalProject {
  id: string;
  workspaceId: string;
  name: string;
  instructions: string;
  knowledgeSourceIds: string[];
  threadId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
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

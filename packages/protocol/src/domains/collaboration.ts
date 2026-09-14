/** Account-private coordination. These records grant no tool authority. */
export type WorkStatus =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "awaiting-approval"
  | "awaiting-user"
  | "completed"
  | "failed"
  | "cancelled";

export interface ConversationParticipant {
  agentId: string;
  /** Name retained when the profile is later removed or renamed. */
  name: string;
}

export type ObjectReference = { workspaceId: string; kind: "agent" | "project" | "conversation" | "work" | "memory" | "file" | "message"; id: string };
export interface ChatBinding { role: "main" | "side"; ownerKind: "agent" | "project"; ownerId: string }
/** Explicit sharing never conveys authority. Snapshots retain selected bytes;
 * live references resolve again under the current account on each deliberate use. */
export type ContextShare =
  | { mode: "snapshot"; source: ObjectReference; sourceRevision: string; text: string; capturedAt: string }
  | { mode: "live-reference"; source: ObjectReference };

export interface ConversationRoom {
  /** Missing only for unclassified legacy conversations; never guess a main Chat. */
  chat?: ChatBinding;
  id: string;
  workspaceId: string;
  kind: "direct" | "group";
  title: string;
  projectId?: string;
  facilitatorId?: string;
  participants: ConversationParticipant[];
  revision: number;
  generation: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationAuthor extends ConversationParticipant {
  runId: string;
  conversationId: string;
}

export interface ProjectTeam {
  projectId: string;
  leadAgentId?: string;
  participantIds: string[];
  revision: number;
}

export interface WorkOutput {
  runId: string;
  conversationId: string;
  text: string;
  /** An agent report is evidence of the report, not a verified external outcome. */
  evidence: "agent-report";
  createdAt: string;
}

export interface CapturedWorkContext extends Extract<ContextShare, { mode: "snapshot" }> { version: 1 }
export interface WorkSteering { id: string; text: string; createdAt: string }
/** Durable reference for one file or input attached to a request. */
export interface WorkAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** image-input and transient bytes existed only in memory and cannot be restored after restart. */
  availability: "image-input" | "transient" | "knowledge-context" | "workspace-file";
  /** Workspace-file refs carry the staged path under the account root's Attachments/. */
  relativePath?: string;
  /** Knowledge refs carry the exact source identity resolved on each deliberate use. */
  sourceId?: string;
  /** Workspace-file refs carry the staged content hash; native code re-verifies the exact bytes before dispatch. */
  sha256?: string;
}
export interface CollaborationWorkItem {
  /** Frozen native context captured at admission. Absent legacy Work requires outcome review. */
  capturedContext?: CapturedWorkContext;
  steering?: WorkSteering[];
  /** Durable attachment references recorded at submission and refreshed at dispatch. */
  attachments?: WorkAttachment[];
  /** Where the request came from. Absent legacy Work predates origins (chat). */
  origin?: "chat" | "schedule";
  permissionMode: import("./approvals").PermissionMode;
  id: string;
  workspaceId: string;
  conversationId: string;
  projectId?: string;
  rootId: string;
  parentId?: string;
  agentId: string;
  agentName: string;
  prompt: string;
  /** Original user instruction retained separately from delegated contributions. */
  userRequest: string;
  status: WorkStatus;
  reason?: string;
  dependencies: string[];
  waitingFor: string[];
  prerequisites: string[];
  awaitingUser: boolean;
  generation: number;
  conversationGeneration: number;
  contextRevision: number;
  depth: number;
  turnCount: number;
  tokenUsage: number;
  maxTurns: number;
  maxTokens: number;
  runIds: string[];
  currentRunId?: string;
  /** Captured route is immutable for an admitted assignment. */
  modelOptionId: string;
  outputs: WorkOutput[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectFact {
  id: string;
  projectId: string;
  kind: "fact" | "decision";
  text: string;
  confidence: "confirmed" | "inference" | "external-observation";
  status: "current" | "superseded" | "stale" | "forgotten";
  conversationId: string;
  runId?: string;
  source: string;
  supersedesId?: string;
  createdAt: string;
}

export type WorkspaceView =
  | {
      id: string;
      conversationId: string;
      kind: "conversation";
    }
  | {
      id: string;
      conversationId: string;
      kind: "artifact";
      agentId: string;
      output: string;
      title: string;
    };

export type ConversationLayoutNode =
  | { kind: "pane"; pane: number }
  | {
      kind: "split";
      axis: "row" | "column";
      ratio: number;
      children: [ConversationLayoutNode, ConversationLayoutNode];
    };

export interface ConversationLayout {
  version: 2;
  panes: string[][];
  views: WorkspaceView[];
  active: (string | null)[];
  activePane: number;
  tree: ConversationLayoutNode;
  closed: WorkspaceView[];
}

export interface CollaborationSnapshot {
  conversations: ConversationRoom[];
  authors: ConversationAuthor[];
  teams: ProjectTeam[];
  work: CollaborationWorkItem[];
  facts: ProjectFact[];
  layout: ConversationLayout | null;
}

/** Exact native operation inputs. Agent operations additionally require a live bound attempt. */
export type CollaborationCommand =
  | { action: "steer-work"; id: string; expectedGeneration: number; eventId: string; text: string }
  | { action: "open-main-chat"; agentId: string }
  | {
      action: "create-conversation";
      id: string;
      title: string;
      kind: ConversationRoom["kind"];
      participantIds: string[];
      facilitatorId: string;
      projectId?: string;
    }
  | {
      action: "update-conversation";
      id: string;
      expectedRevision: number;
      title: string;
      participantIds: string[];
      facilitatorId: string;
      shareHistory: boolean;
    }
  | {
      action: "place-conversation";
      id: string;
      expectedRevision: number;
      projectId: string;
      shareHistory: true;
    }
  | {
      action: "update-team";
      projectId: string;
      expectedRevision: number;
      leadAgentId?: string;
      participantIds: string[];
      shareHistory: boolean;
    }
  | {
      action: "start-work";
      id: string;
      conversationId: string;
      agentId: string;
      prompt: string;
      discussion: boolean;
      /** Composer-level attachment references captured with the request. */
      attachments?: WorkAttachment[];
    }
  | { action: "bind-work"; id: string; generation: number; runId: string; attachments?: WorkAttachment[] }
  | { action: "check-work"; id: string; generation: number; runId: string }
  | {
      action: "finish-work";
      id: string;
      generation: number;
      runId: string;
      status: "completed" | "failed" | "cancelled" | "awaiting-user";
      reason?: string;
    }
  | { action: "stop-work"; id: string }
  | { action: "stop-project"; projectId: string }
  | {
      action: "continue-work";
      id: string;
      expectedGeneration: number;
      reconcile: true;
    }
  | {
      action: "work-status";
      id: string;
      generation: number;
      status: "awaiting-approval" | "running" | "failed";
      reason?: string;
    }
  | {
      action: "agent-command";
      id: string;
      generation: number;
      runId: string;
      callId: string;
      command: CollaborationAgentCommand;
    }
  | {
      action: "save-fact";
      projectId: string;
      conversationId: string;
      id: string;
      kind: ProjectFact["kind"];
      text: string;
      source: string;
      supersedesId?: string;
    }
  | {
      action: "change-fact";
      id: string;
      projectId: string;
      status: "stale" | "forgotten";
    }
  | { action: "save-layout"; layout: ConversationLayout };

export type CollaborationAgentCommand =
  | {
      kind: "delegate";
      agentId: string;
      prompt: string;
      title: string;
      dependencies: string[];
      focused: boolean;
    }
  | {
      kind: "record-fact";
      text: string;
      factKind: ProjectFact["kind"];
      source: string;
      confidence: "inference" | "external-observation";
      supersedesId?: string;
    }
  | { kind: "await-user"; reason: string };

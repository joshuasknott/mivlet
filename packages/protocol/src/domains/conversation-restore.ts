import type { RepositoryCheckpoint, RepositoryCheckpointPreview } from "./repository-checkpoints";
import type { RepositoryWorkBinding } from "./coding";

export interface ConversationRestoreOwner { workspaceId: string; conversationId: string; agentId: string }
export interface ConversationRestorePoint extends ConversationRestoreOwner {
  id: string;
  workId: string;
  workGeneration: number;
  runId: string;
  targetHeadId: string | null;
  requestMessageId: string | null;
  label: string;
  createdAt: string;
  repository: RepositoryWorkBinding;
  checkpoint: RepositoryCheckpoint;
}
export interface ConversationRestoreReview {
  id: string;
  point: ConversationRestorePoint;
  expectedHeadId: string | null;
  expectedLastSequence: number;
  computerGeneration: number;
  checkpoint: RepositoryCheckpointPreview;
  direction: "restore" | "revert-files";
  revertsIntentId: string | null;
}
export interface ConversationRestoreIntent {
  id: string;
  review: ConversationRestoreReview;
  approvalRequestId: string;
  state: "prepared" | "files-restored" | "complete" | "reverted" | "cancelled";
  beforeRestoreCheckpointId: string | null;
  fileReceiptTree: string | null;
  selectedHeadId: string | null;
}
export interface ConversationRestoreListing {
  points: ConversationRestorePoint[];
  intents: ConversationRestoreIntent[];
  observed?: { intentId: string; kind: "unchanged" | "files-restored" | "changed"; treeId: string; beforeRestoreCheckpointId: string | null; currentHeadId: string | null; currentLastSequence: number; conversationChanged: boolean } | null;
}

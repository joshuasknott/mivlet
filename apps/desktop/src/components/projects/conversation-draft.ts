export interface ConversationDraft {
  kind: "direct" | "project";
  title: string;
  instructions: string;
  participantIds: string[];
  /** Empty when the Project Team has no designated coordinator. */
  facilitatorId: string;
  shareHistory: boolean;
  /** Imported, member-owned knowledge selected for a new project. */
  knowledgeSourceIds?: string[];
}

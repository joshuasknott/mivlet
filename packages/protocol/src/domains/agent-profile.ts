import type { ApprovalPresetLabel } from "./approvals.js";

export type MivletAgentIcon = "agent";

/** A repeatable responsibility explicitly taught to a teammate by the user. */
export interface MivletLearnedTask {
  id: string;
  title: string;
  instruction: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A user-owned agent. Instructions and selections are non-secret; provider
 * credentials remain in the native credential boundary.
 */
export interface MivletAgentProfile {
  id: string;
  name: string;
  instructions: string;
  modelId: string;
  reasoningEffort?: string;
  /** Opt-in faster processing for models that advertise a supported service tier. */
  fastMode?: boolean;
  icon: MivletAgentIcon;
  /** In-app completion and attention notices; never controls approval prompts. */
  notificationsEnabled?: boolean;
  /** Legacy appearance metadata retained for saved-profile compatibility. */
  iconColor: string;
  /** Versioned, non-secret seed for a stable generated blob portrait. */
  avatarSeed?: string;
  /** Locally uploaded, normalized image. Remote URLs are deliberately unsupported. */
  iconImageDataUrl?: string;
  connectorIds: string[];
  knowledgeSourceIds: string[];
  /** Structured, reviewable work learned from conversation. */
  learnedTasks?: MivletLearnedTask[];
  permissionLabel: ApprovalPresetLabel;
  threadId?: string;
  /** Local conversation references for this teammate, including earlier chats. */
  threadIds?: string[];
}

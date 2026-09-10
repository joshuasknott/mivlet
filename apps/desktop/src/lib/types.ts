import type {
  ApprovalModification,
  ApprovalRequest,
  ApprovalDecision,
  ApprovalPresetLabel,
  CustomApprovalSettings,
  LocalFileImport,
  MemoryRecord,
  PermissionMode
} from "@fable/protocol";

/**
 * Local shell-only types derived from protocol types. Keeping them in one
 * place lets the persistence, snapshot, and UI layers reference the same
 * shapes without App.tsx owning them.
 */

export type AccountPage = "Profile" | "Settings";
export type WorkspacePage = AccountPage;

export type ApprovalModificationDraft = {
  mode: ApprovalModification["mode"];
  dataUsed: string;
  consequence: string;
};

export type PendingApprovalConfirmation = {
  request: ApprovalRequest;
  decision: ApprovalDecision;
  modification?: ApprovalModification;
};

export interface ComposerAttachment {
  id: string;
  name: string;
  type: string;
  sizeBytes: number;
  previewUrl?: string;
  /** Prepared transient model input. Its data URL must never enter durable state. */
  imageInput?: import("@fable/protocol").NativeImageInput;
  sourceId?: string;
  /** Original upload bytes for one pending send. Never persisted in a draft. */
  transientBytes?: Uint8Array;
  workspaceFile?: import("@fable/protocol").LocalComputerAttachmentReceipt;
  status?: string;
}

export interface PersistedShellState {
  activeItem: string;
  composerValue: string;
  voiceEnabled: boolean;
  voiceProvider?: "browser" | "openai";
  approvalAudit: import("@fable/protocol").ApprovalAuditEntry[];
  dismissedApprovalIds: string[];
  approvalRules: import("@fable/protocol").ApprovalGrant[];
  /** User-owned agents. Optional only for snapshots created before agents existed. */
  agents?: import("@fable/protocol").FableAgentProfile[];
  activeAgentId?: string;
  pinnedSourceIds: string[];
  importedKnowledgeSources: LocalFileImport[];
  memoryDisabled: boolean;
  memoryRecords: MemoryRecord[];
  /** Provider ids of connected agent-runtime backends. Secrets never persist here. */
  connectedBackendIds: string[];
  /** The user has completed provider onboarding. */
  onboardingComplete?: boolean;
  /** Version of the complete first-run journey the user finished. */
  onboardingVersion?: number;
  /** Model id last chosen in the composer's model picker (re-validated before use). */
  selectedModelId: string;
  hiddenModelIds?: string[];
  /** Composer permission level driving agent-run tool gating. */
  permissionMode: PermissionMode;
  /** User-facing approval preset label shown in the composer. */
  permissionLabel: ApprovalPresetLabel;
  /** Plain-language Custom approval preferences; no secrets. */
  customApprovalSettings: CustomApprovalSettings;
}

export const EMPTY_APPROVAL_MODIFICATION: ApprovalModificationDraft = {
  mode: "read-only",
  dataUsed: "",
  consequence: ""
};

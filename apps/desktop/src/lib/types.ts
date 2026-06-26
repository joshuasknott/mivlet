import type {
  ApprovalModification,
  ApprovalRequest,
  ApprovalDecision,
  AutomationStatus,
  LocalFileImport,
  MemoryRecord,
  AutomationRule
} from "@arden/protocol";

/**
 * Local shell-only types derived from protocol types. Keeping them in one
 * place lets the persistence, snapshot, and UI layers reference the same
 * shapes without App.tsx owning them.
 */

export type UtilityItem = "Knowledge" | "Plugins" | "Automations";

export type AutomationRuleView = Omit<AutomationRule, "status"> & { status: AutomationStatus };

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

export interface PersistedShellState {
  activeItem: string;
  composerValue: string;
  voiceEnabled: boolean;
  approvalAudit: import("@arden/protocol").ApprovalAuditEntry[];
  dismissedApprovalIds: string[];
  approvalRules: import("@arden/protocol").ApprovalGrant[];
  automationStatuses: Record<string, AutomationStatus>;
  pinnedSourceIds: string[];
  importedKnowledgeSources: LocalFileImport[];
  memoryDisabled: boolean;
  memoryRecords: MemoryRecord[];
}

export const EMPTY_APPROVAL_MODIFICATION: ApprovalModificationDraft = {
  mode: "read-only",
  dataUsed: "",
  consequence: ""
};

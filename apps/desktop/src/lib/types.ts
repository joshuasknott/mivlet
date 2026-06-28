import type {
  ApprovalModification,
  ApprovalRequest,
  ApprovalDecision,
  LocalFileImport,
  MemoryRecord,
  PermissionMode,
  ScheduleEntry,
  ScheduleWeekday
} from "@fable/protocol";

/**
 * Local shell-only types derived from protocol types. Keeping them in one
 * place lets the persistence, snapshot, and UI layers reference the same
 * shapes without App.tsx owning them.
 */

export type UtilityItem = "Connectors" | "Knowledge" | "Schedules";
export type AccountPage = "Profile" | "Settings";
export type WorkspacePage = UtilityItem | AccountPage;

/**
 * A user-created schedule. Shell-local alias for the shared `ScheduleEntry`
 * contract: the `name` is the queryable task name, the `description` tells the
 * agent what to do when it fires, and `day`/`time` define when it runs.
 * Execution is linked up so a connected model can pick it up; nothing
 * auto-runs. Now persisted through the runtime snapshot so it survives a
 * desktop restart (localStorage carries it in preview only).
 */
export type Weekday = ScheduleWeekday;
export type Schedule = ScheduleEntry;

export const WEEKDAYS: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

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
  approvalAudit: import("@fable/protocol").ApprovalAuditEntry[];
  dismissedApprovalIds: string[];
  approvalRules: import("@fable/protocol").ApprovalGrant[];
  schedules: Schedule[];
  pinnedSourceIds: string[];
  importedKnowledgeSources: LocalFileImport[];
  memoryDisabled: boolean;
  memoryRecords: MemoryRecord[];
  /** Provider ids of connected agent-runtime backends. Secrets never persist here. */
  connectedBackendIds: string[];
  /** Model id last chosen in the composer's model picker (re-validated before use). */
  selectedModelId: string;
  /** Composer permission level driving agent-run tool gating. */
  permissionMode: PermissionMode;
}

export const EMPTY_APPROVAL_MODIFICATION: ApprovalModificationDraft = {
  mode: "read-only",
  dataUsed: "",
  consequence: ""
};

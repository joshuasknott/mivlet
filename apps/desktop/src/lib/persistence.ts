import type {
  ApprovalAuditEntry,
  ApprovalGrant,
  AutomationStatus,
  LocalFileImport,
  MemoryRecord,
  RuntimeSnapshot
} from "@arden/protocol";
import { LEGACY_STORAGE_KEY, STORAGE_KEY, RUNTIME_SNAPSHOT_VERSION } from "./constants";
import { normalizeActiveItem } from "./helpers";
import type { PersistedShellState } from "./types";

/**
 * LocalStorage persistence and Tauri runtime snapshot conversion. These are
 * pure functions over shell state so they can be tested and reused without
 * React.
 */

export function readPersistedShellState(defaultShellState: PersistedShellState): PersistedShellState {
  if (typeof window === "undefined") {
    return defaultShellState;
  }

  try {
    const stored =
      window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!stored) {
      return defaultShellState;
    }

    return normalizePersistedShellState({
      ...defaultShellState,
      ...JSON.parse(stored)
    } as PersistedShellState);
  } catch {
    return defaultShellState;
  }
}

export function persistShellState(state: PersistedShellState) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Local persistence is best-effort in preview and private browsing modes.
  }
}

export function shellStateToRuntimeSnapshot(state: PersistedShellState): RuntimeSnapshot {
  return {
    version: RUNTIME_SNAPSHOT_VERSION,
    activeItem: state.activeItem,
    composerDraft: state.composerValue,
    voiceEnabled: state.voiceEnabled,
    approvalAudit: state.approvalAudit,
    dismissedApprovalIds: state.dismissedApprovalIds,
    approvalRules: state.approvalRules,
    automationStatuses: state.automationStatuses,
    pinnedSourceIds: state.pinnedSourceIds,
    importedKnowledgeSources: state.importedKnowledgeSources,
    memoryDisabled: state.memoryDisabled,
    memoryRecords: state.memoryRecords,
    savedAt: new Date().toISOString()
  };
}

export function shellStateFromRuntimeSnapshot(
  snapshot: RuntimeSnapshot,
  defaultShellState: PersistedShellState
): PersistedShellState {
  return {
    ...defaultShellState,
    activeItem: normalizeActiveItem(snapshot.activeItem || defaultShellState.activeItem),
    composerValue: snapshot.composerDraft,
    voiceEnabled: snapshot.voiceEnabled,
    approvalAudit: snapshot.approvalAudit,
    dismissedApprovalIds: snapshot.dismissedApprovalIds,
    approvalRules: snapshot.approvalRules,
    automationStatuses: snapshot.automationStatuses,
    pinnedSourceIds: snapshot.pinnedSourceIds,
    importedKnowledgeSources: snapshot.importedKnowledgeSources,
    memoryDisabled: snapshot.memoryDisabled,
    memoryRecords: snapshot.memoryRecords
  };
}

function normalizePersistedShellState(state: PersistedShellState): PersistedShellState {
  return {
    ...state,
    activeItem: normalizeActiveItem(state.activeItem)
  };
}

// re-export protocol array types referenced by callers
export type {
  ApprovalAuditEntry,
  ApprovalGrant,
  AutomationStatus,
  LocalFileImport,
  MemoryRecord
};

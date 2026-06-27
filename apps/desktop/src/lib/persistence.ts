import type {
  ApprovalAuditEntry,
  ApprovalGrant,
  LocalFileImport,
  MemoryRecord,
  PermissionMode,
  RuntimeSnapshot
} from "@fable/protocol";
import { LEGACY_STORAGE_KEYS, STORAGE_KEY, RUNTIME_SNAPSHOT_VERSION } from "./constants";
import { normalizeActiveItem } from "./helpers";
import type { PersistedShellState } from "./types";

/**
 * LocalStorage persistence and Tauri runtime snapshot conversion. These are
 * pure functions over shell state so they can be tested and reused without
 * React.
 *
 * Schedules are shell-local and persist only via localStorage (they are not
 * part of the shared RuntimeSnapshot contract). The snapshot still carries
 * the legacy `automationStatuses` field for protocol compatibility, defaulted
 * to an empty record on round-trip.
 */

export function readPersistedShellState(defaultShellState: PersistedShellState): PersistedShellState {
  if (typeof window === "undefined") {
    return defaultShellState;
  }

  try {
    const currentStored = window.localStorage.getItem(STORAGE_KEY);
    const legacyStored = currentStored
      ? null
      : LEGACY_STORAGE_KEYS.map((key) => window.localStorage.getItem(key)).find(Boolean) ?? null;
    const stored = currentStored ?? legacyStored;
    if (!stored) {
      return defaultShellState;
    }

    const normalized = normalizePersistedShellState({
      ...defaultShellState,
      ...JSON.parse(stored)
    } as PersistedShellState);
    if (!currentStored && legacyStored) {
      // Copy forward without deleting the old key so downgrade/rollback remains safe.
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    }
    return normalized;
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
    // Schedules are shell-local; the shared snapshot keeps the legacy field
    // defaulted empty for protocol compatibility.
    automationStatuses: {},
    pinnedSourceIds: state.pinnedSourceIds,
    importedKnowledgeSources: state.importedKnowledgeSources,
    memoryDisabled: state.memoryDisabled,
    memoryRecords: state.memoryRecords,
    connectedBackendIds: state.connectedBackendIds,
    selectedModelId: state.selectedModelId,
    permissionMode: state.permissionMode,
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
    pinnedSourceIds: snapshot.pinnedSourceIds,
    importedKnowledgeSources: snapshot.importedKnowledgeSources,
    memoryDisabled: snapshot.memoryDisabled,
    memoryRecords: snapshot.memoryRecords,
    connectedBackendIds: snapshot.connectedBackendIds,
    selectedModelId: snapshot.selectedModelId ?? defaultShellState.selectedModelId,
    permissionMode: snapshot.permissionMode ?? defaultShellState.permissionMode
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
  LocalFileImport,
  MemoryRecord
};

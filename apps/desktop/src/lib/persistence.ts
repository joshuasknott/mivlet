import type {
  ApprovalAuditEntry,
  ApprovalGrant,
  LocalFileImport,
  MemoryRecord,
  PermissionMode,
  RuntimeSnapshot,
  ScheduleEntry
} from "@fable/protocol";
import { normalizeCustomApprovalSettings } from "@fable/connectors";
import {
  LEGACY_STORAGE_KEYS,
  LEGACY_IMPORT_SENTINEL,
  STORAGE_KEY,
  RUNTIME_SNAPSHOT_VERSION
} from "./constants";
import {
  DEFAULT_PERMISSION_LABEL,
  isApprovalPresetLabel,
  permissionLabelFor,
  permissionModeFor
} from "./agent-run";
import { normalizeActiveItem } from "./helpers";
import type { PersistedShellState } from "./types";

/**
 * LocalStorage persistence and Tauri runtime snapshot conversion. These are
 * pure functions over shell state so they can be tested and reused without
 * React.
 *
 * Source-of-truth rules (the safe interim migration toward encrypted SQLite):
 *
 * - **Desktop (Tauri runtime):** the runtime snapshot is the source of truth
 *   for non-secret state. `localStorage` is a write-only best-effort mirror —
 *   it is read exactly once, on first launch, to import legacy values via
 *   `importLegacyShellStateOnce`, and never read again.
 * - **Preview (no Tauri runtime):** `localStorage` remains the sole store.
 *
 * Schedules persist through the runtime snapshot so they survive a desktop
 * restart (the snapshot is the source of truth for non-secret state in Tauri);
 * localStorage carries them in preview only. The snapshot still carries the
 * legacy `automationStatuses` field for protocol compatibility, defaulted to
 * an empty record on round-trip.
 */

/** True inside the Tauri desktop runtime (mirrors `runtime.ts`). */
export function hasTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  );
}

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

/**
 * Desktop one-time legacy import. Reads the legacy `localStorage` keys a single
 * time (guarded by the `LEGACY_IMPORT_SENTINEL` flag), copies the recovered
 * non-secret state forward, marks the import done, and returns the merged
 * state. Every subsequent call returns the defaults — the snapshot is the
 * source of truth from then on.
 *
 * Safe by construction: it only ever copies the documented `PersistedShellState`
 * fields forward; it never introduces secret-named keys, and the sentinel it
 * writes is a plain `"1"` marker with no payload.
 */
export function importLegacyShellStateOnce(
  defaultShellState: PersistedShellState
): PersistedShellState {
  if (typeof window === "undefined") {
    return defaultShellState;
  }

  try {
    if (window.localStorage.getItem(LEGACY_IMPORT_SENTINEL)) {
      return defaultShellState;
    }

    const legacyStored =
      LEGACY_STORAGE_KEYS.map((key) => window.localStorage.getItem(key)).find(Boolean) ?? null;
    if (!legacyStored) {
      // Nothing to import; still mark the migration done so we never scan again.
      window.localStorage.setItem(LEGACY_IMPORT_SENTINEL, "1");
      return defaultShellState;
    }

    const normalized = normalizePersistedShellState({
      ...defaultShellState,
      ...JSON.parse(legacyStored)
    } as PersistedShellState);
    // Copy forward to the canonical key (downgrade-safe: the legacy key stays).
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    window.localStorage.setItem(LEGACY_IMPORT_SENTINEL, "1");
    return normalized;
  } catch {
    return defaultShellState;
  }
}

/**
 * Write-only best-effort mirror of shell state into `localStorage`. This never
 * reads — preview relies on it as its sole store, while desktop treats the
 * snapshot as the source of truth and uses this only as a harmless mirror.
 */
export function persistShellState(state: PersistedShellState) {
  if (typeof window === "undefined") {
    return;
  }

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
    // The legacy automation field is kept defaulted empty for protocol
    // compatibility; live schedules live in `schedules` below.
    automationStatuses: {},
    schedules: state.schedules,
    goals: state.goals,
    plans: state.plans,
    pinnedSourceIds: state.pinnedSourceIds,
    importedKnowledgeSources: state.importedKnowledgeSources,
    memoryDisabled: state.memoryDisabled,
    memoryRecords: state.memoryRecords,
    connectedBackendIds: state.connectedBackendIds,
    selectedModelId: state.selectedModelId,
    permissionMode: state.permissionMode,
    permissionLabel: state.permissionLabel,
    customApprovalSettings: state.customApprovalSettings,
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
    voiceEnabled: snapshot.voiceEnabled !== false,
    approvalAudit: snapshot.approvalAudit,
    dismissedApprovalIds: snapshot.dismissedApprovalIds,
    approvalRules: snapshot.approvalRules,
    // Schedules are the source of truth in the snapshot; fall back to the
    // default shell state's schedules when a snapshot omits them.
    schedules: snapshot.schedules ?? defaultShellState.schedules,
    // Goals/plans are non-secret structured state persisted through the
    // snapshot; fall back to defaults when a snapshot omits them.
    goals: snapshot.goals ?? defaultShellState.goals,
    plans: snapshot.plans ?? defaultShellState.plans,
    pinnedSourceIds: snapshot.pinnedSourceIds,
    importedKnowledgeSources: snapshot.importedKnowledgeSources,
    memoryDisabled: snapshot.memoryDisabled,
    memoryRecords: snapshot.memoryRecords,
    connectedBackendIds: snapshot.connectedBackendIds,
    selectedModelId: snapshot.selectedModelId ?? defaultShellState.selectedModelId,
    permissionMode: snapshot.permissionMode ?? defaultShellState.permissionMode,
    permissionLabel: normalizeApprovalPresetLabel(
      snapshot.permissionLabel,
      snapshot.permissionMode ?? defaultShellState.permissionMode
    ),
    customApprovalSettings: normalizeCustomApprovalSettings(
      snapshot.customApprovalSettings ?? defaultShellState.customApprovalSettings
    )
  };
}

function normalizePersistedShellState(state: PersistedShellState): PersistedShellState {
  const permissionMode = normalizePermissionMode(state.permissionMode);
  return {
    ...state,
    activeItem: normalizeActiveItem(state.activeItem),
    voiceEnabled: state.voiceEnabled !== false,
    permissionMode,
    permissionLabel: normalizeApprovalPresetLabel(state.permissionLabel, permissionMode),
    customApprovalSettings: normalizeCustomApprovalSettings(state.customApprovalSettings)
  };
}

function normalizePermissionMode(mode: PermissionMode | undefined): PermissionMode {
  return mode === "read-only" || mode === "trusted-scope" || mode === "full-access"
    ? mode
    : permissionModeFor(DEFAULT_PERMISSION_LABEL);
}

function normalizeApprovalPresetLabel(
  label: string | undefined,
  mode: PermissionMode
) {
  return label && isApprovalPresetLabel(label) ? label : permissionLabelFor(mode);
}

// re-export protocol array types referenced by callers
export type {
  ApprovalAuditEntry,
  ApprovalGrant,
  LocalFileImport,
  MemoryRecord,
  ScheduleEntry
};

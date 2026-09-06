import type {
  ApprovalAuditEntry,
  ApprovalGrant,
  FableAgentProfile,
  LocalFileImport,
  MemoryRecord,
  PermissionMode,
  RuntimeSnapshot
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

const AGENT_ICON_COLORS = ["#865DFA", "#3581FB", "#2CC663", "#FCBD22", "#FC6D69", "#555B63"];
const MAX_AGENT_IMAGE_DATA_URL_CHARACTERS = 512_000;
const MAX_AGENT_LEARNED_TASKS = 24;
const MAX_AGENT_LEARNED_TASK_TITLE = 120;
const MAX_AGENT_LEARNED_TASK_INSTRUCTION = 4_000;

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
    agents: state.agents,
    activeAgentId: state.activeAgentId,
    pinnedSourceIds: state.pinnedSourceIds,
    importedKnowledgeSources: state.importedKnowledgeSources,
    memoryDisabled: state.memoryDisabled,
    memoryRecords: state.memoryRecords,
    connectedBackendIds: state.connectedBackendIds,
    onboardingComplete: state.onboardingComplete,
    onboardingVersion: state.onboardingVersion,
    selectedModelId: state.selectedModelId,
    hiddenModelIds: state.hiddenModelIds ?? [],
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
    agents: normalizeAgentProfiles(snapshot.agents?.length ? snapshot.agents : defaultShellState.agents),
    activeAgentId: snapshot.activeAgentId ?? defaultShellState.activeAgentId,
    pinnedSourceIds: snapshot.pinnedSourceIds,
    importedKnowledgeSources: snapshot.importedKnowledgeSources,
    memoryDisabled: snapshot.memoryDisabled,
    memoryRecords: snapshot.memoryRecords,
    connectedBackendIds: snapshot.connectedBackendIds,
    onboardingComplete: snapshot.onboardingComplete ?? defaultShellState.onboardingComplete,
    onboardingVersion: snapshot.onboardingVersion ?? defaultShellState.onboardingVersion ?? 0,
    selectedModelId: snapshot.selectedModelId ?? defaultShellState.selectedModelId,
    hiddenModelIds: snapshot.hiddenModelIds ?? [],
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
    onboardingVersion: state.onboardingVersion ?? 0,
    agents: normalizeAgentProfiles(state.agents),
    permissionMode,
    permissionLabel: normalizeApprovalPresetLabel(state.permissionLabel, permissionMode),
    customApprovalSettings: normalizeCustomApprovalSettings(state.customApprovalSettings)
  };
}

function normalizeAgentProfiles(agents: FableAgentProfile[] | undefined): FableAgentProfile[] {
  return (agents ?? []).map((agent, index) => {
    const iconColor = typeof agent.iconColor === "string" && /^#[0-9a-f]{6}$/i.test(agent.iconColor)
      ? agent.iconColor.toUpperCase()
      : AGENT_ICON_COLORS[index % AGENT_ICON_COLORS.length];
    const iconImageDataUrl = typeof agent.iconImageDataUrl === "string"
      && /^data:image\/(?:png|jpeg|webp);base64,/i.test(agent.iconImageDataUrl)
      && agent.iconImageDataUrl.length <= MAX_AGENT_IMAGE_DATA_URL_CHARACTERS
      ? agent.iconImageDataUrl
      : undefined;
    const learnedTasks = Array.isArray(agent.learnedTasks)
      ? agent.learnedTasks
        .filter((task) => task && typeof task === "object")
        .slice(0, MAX_AGENT_LEARNED_TASKS)
        .map((task) => ({
          id: typeof task.id === "string" ? task.id.trim().slice(0, 120) : "",
          title: typeof task.title === "string"
            ? task.title.trim().slice(0, MAX_AGENT_LEARNED_TASK_TITLE)
            : "",
          instruction: typeof task.instruction === "string"
            ? task.instruction.trim().slice(0, MAX_AGENT_LEARNED_TASK_INSTRUCTION)
            : "",
          createdAt: typeof task.createdAt === "string" ? task.createdAt : "",
          updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : ""
        }))
        .filter((task) => task.id && task.title && task.instruction)
      : [];
    return {
      ...agent,
      reasoningEffort: typeof agent.reasoningEffort === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(agent.reasoningEffort) ? agent.reasoningEffort : undefined,
      icon: "agent",
      iconColor,
      avatarSeed: typeof agent.avatarSeed === "string" && agent.avatarSeed.startsWith("blob-v1:") && agent.avatarSeed.length <= 160
        ? agent.avatarSeed : `blob-v1:${agent.id}`,
      iconImageDataUrl,
      threadIds: [...new Set([
        ...(Array.isArray(agent.threadIds) ? agent.threadIds.filter((id): id is string => typeof id === "string" && id.length > 0) : []),
        ...(typeof agent.threadId === "string" && agent.threadId ? [agent.threadId] : []),
      ])],
      learnedTasks
    };
  });
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

// Re-export protocol array types referenced by callers.
export type {
  ApprovalAuditEntry,
  ApprovalGrant,
  LocalFileImport,
  MemoryRecord
};

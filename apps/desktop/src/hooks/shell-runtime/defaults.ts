import type { IdentityStatus } from "@fable/protocol";
import { DEFAULT_CUSTOM_APPROVAL_SETTINGS } from "@fable/connectors";
import { knowledgeSources, memoryRecords } from "../../data/workspace";
import { DEFAULT_PERMISSION_LABEL } from "../../lib/agent-run";
import type { PersistedShellState } from "../../lib/types";

export const defaultShellState: PersistedShellState = {
  activeItem: "new-chat",
  composerValue: "",
  voiceEnabled: true,
  approvalAudit: [],
  dismissedApprovalIds: [],
  approvalRules: [],
  schedules: [],
  goals: [],
  plans: [],
  pinnedSourceIds: knowledgeSources.filter((source) => source.pinned).map((source) => source.id),
  importedKnowledgeSources: [],
  memoryDisabled: false,
  memoryRecords,
  connectedBackendIds: [],
  // "" lets Fable pick the first available model. Ask Me is the default
  // approval preset.
  selectedModelId: "",
  permissionMode: "trusted-scope",
  permissionLabel: DEFAULT_PERMISSION_LABEL,
  customApprovalSettings: DEFAULT_CUSTOM_APPROVAL_SETTINGS
};

export const ALLOW_PREVIEW_FALLBACKS =
  import.meta.env.DEV || import.meta.env.MODE === "test";

export const DEFAULT_IDENTITY_STATUS: IdentityStatus = {
  enabled: false,
  state: "disabled",
  message: "Fable account setup is not configured.",
  scopes: []
};

export function runtimeOrPreview<T>(
  runtimeValue: T | null,
  previewValue: () => T,
  unavailableMessage: string
): T {
  if (runtimeValue !== null) {
    return runtimeValue;
  }
  if (ALLOW_PREVIEW_FALLBACKS) {
    return previewValue();
  }
  throw new Error(unavailableMessage);
}

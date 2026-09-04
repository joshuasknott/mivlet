import type { AccountWorkspaceStatus, IdentityStatus } from "@fable/protocol";
import { DEFAULT_CUSTOM_APPROVAL_SETTINGS } from "@fable/connectors";
import { knowledgeSources, memoryRecords } from "../../data/workspace";
import { DEFAULT_PERMISSION_LABEL } from "../../lib/agent-run";
import type { PersistedShellState } from "../../lib/types";

export const CURRENT_ONBOARDING_VERSION = 2;

export const defaultShellState: PersistedShellState = {
  activeItem: "new-chat",
  composerValue: "",
  voiceEnabled: true,
  approvalAudit: [],
  dismissedApprovalIds: [],
  approvalRules: [],
  agents: [
    {
      id: "chief-of-staff",
      name: "Chief of Staff",
      instructions: "Coordinate my work, keep priorities clear, and help me move from decision to execution.",
      modelId: "",
      icon: "agent",
      iconColor: "#865DFA",
      connectorIds: [],
      knowledgeSourceIds: [],
      permissionLabel: DEFAULT_PERMISSION_LABEL
    }
  ],
  activeAgentId: "chief-of-staff",
  pinnedSourceIds: knowledgeSources.filter((source) => source.pinned).map((source) => source.id),
  importedKnowledgeSources: [],
  memoryDisabled: false,
  memoryRecords,
  connectedBackendIds: [],
  onboardingComplete: false,
  onboardingVersion: 0,
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

/** Native starts with one installation-local workspace; account state loads separately. */
export const DEFAULT_ACCOUNT_WORKSPACE_STATUS: AccountWorkspaceStatus = {
  configured: false,
  state: "ready",
  message: "Local workspace ready. A Fable account is optional.",
  accountBound: true,
  workspaces: [],
  activeWorkspace: {
    localWorkspaceId: "default",
    name: "On this PC",
    source: "local"
  },
  activeContextOwner: {
    internalUserId: "local-install"
  },
  devices: []
};

/** Deliberate browser/test fixture; production native identity starts disabled. */
export const PREVIEW_IDENTITY_STATUS: IdentityStatus = {
  enabled: true,
  state: "signed-in",
  message: "Preview account signed in.",
  issuer: "https://preview.fable.invalid",
  audience: "fable-preview",
  scopes: ["account:preview"],
  authentication: {
    provider: "clerk",
    normalizedIssuer: "https://preview.fable.invalid",
    subject: "preview-user",
    authenticationEventRef: "preview-auth-event",
    sessionRef: "preview-session",
    authenticatedAt: "1970-01-01T00:00:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z",
    verifiedAttributes: [],
    verifiedDisplayAttributes: { displayName: "Preview user" }
  }
};

/** Deliberate browser/test fixture with the same local-first ownership shape. */
export const PREVIEW_ACCOUNT_WORKSPACE_STATUS: AccountWorkspaceStatus = {
  configured: false,
  state: "ready",
  message: "Preview workspace ready on this browser.",
  accountBound: true,
  workspaces: [],
  activeWorkspace: {
    localWorkspaceId: "preview-default",
    name: "On this browser",
    source: "local"
  },
  activeContextOwner: {
    internalUserId: "preview-user"
  },
  devices: []
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

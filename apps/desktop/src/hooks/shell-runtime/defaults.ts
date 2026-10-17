import { ALLOW_PREVIEW_FALLBACKS } from "../../runtime/preview-policy";
import type { AccountWorkspaceStatus, IdentityStatus } from "@mivlet/protocol";
import { DEFAULT_CUSTOM_APPROVAL_SETTINGS } from "@mivlet/connectors";
import { knowledgeSources, memoryRecords } from "../../data/workspace";
import { DEFAULT_PERMISSION_LABEL } from "../../lib/agent-run";
import type { PersistedShellState } from "../../lib/types";

/** Version marker for the first-agent setup journey. Legacy snapshots use 0. */
export const FIRST_AGENT_ONBOARDING_VERSION = 2 as const;
export const defaultShellState: PersistedShellState = {
  activeItem: "new-chat",
  composerValue: "",
  voiceEnabled: true,
  voiceProvider: "browser",
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
      iconColor: "#3659E3",
      avatarSeed: "ink-v1:0:chief-of-staff",
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
  onboardingVersion: FIRST_AGENT_ONBOARDING_VERSION,
  // "" lets Mivlet pick the first available model. Ask Me is the default
  // approval preset.
  selectedModelId: "",
  permissionMode: "trusted-scope",
  permissionLabel: DEFAULT_PERMISSION_LABEL,
  customApprovalSettings: DEFAULT_CUSTOM_APPROVAL_SETTINGS
};

export { ALLOW_PREVIEW_FALLBACKS } from "../../runtime/preview-policy";

export const DEFAULT_IDENTITY_STATUS: IdentityStatus = {
  enabled: false,
  state: "disabled",
  message: "Mivlet account setup is not configured.",
  scopes: []
};

/** Native must receive a validated account binding before loading product data. */
export const DEFAULT_ACCOUNT_WORKSPACE_STATUS: AccountWorkspaceStatus = {
  configured: false,
  state: "signed-out",
  message: "Sign in to open your account workspace.",
  accountBound: false,
  workspaces: [],
  activeWorkspace: {
    localWorkspaceId: "default",
    name: "On this PC",
    source: "local"
  },
  activeContextOwner: {
    internalUserId: ""
  },
  devices: []
};

/** Deliberate browser/test fixture; production native identity starts disabled. */
export const PREVIEW_IDENTITY_STATUS: IdentityStatus = {
  enabled: true,
  state: "signed-in",
  message: "Preview account signed in.",
  issuer: "https://preview.mivlet.invalid",
  audience: "mivlet-preview",
  scopes: ["account:preview"],
  authentication: {
    provider: "clerk",
    normalizedIssuer: "https://preview.mivlet.invalid",
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

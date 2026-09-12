import type {
  ApprovalRiskLevel,
  CustomApprovalSettings,
  PermissionMode,
  PermissionProfileId
} from "@fable/protocol";

export type PermissionEffect =
  | "coordination"
  | "local-read"
  | "local-write"
  | "delete"
  | "shell-execution"
  | "web-fetch"
  | "browser-read"
  | "browser-state-mutation"
  | "connector-read"
  | "connector-write"
  | "publish-external"
  | "cache-read"
  | "cache-mutation"
  | "app-state-mutation"
  | "memory-promotion";

export interface PermissionPolicyInput {
  mode?: PermissionMode;
  profile?: PermissionProfileId;
  effect: PermissionEffect;
  riskLevel?: ApprovalRiskLevel;
}

export interface PermissionPolicyDecision {
  profile: PermissionProfileId;
  mode: PermissionMode;
  effect: PermissionEffect;
  allowed: boolean;
  approvalRequired: boolean;
  reason: string;
}

const PROFILE_FOR_MODE: Record<PermissionMode, PermissionProfileId> = {
  "read-only": "read-only",
  "trusted-scope": "trusted",
  "full-access": "full-with-approvals"
};

const MODE_FOR_PROFILE: Record<PermissionProfileId, PermissionMode> = {
  "read-only": "read-only",
  trusted: "trusted-scope",
  "full-with-approvals": "full-access"
};

const READ_ONLY_ALLOWED = new Set<PermissionEffect>([
  "coordination",
  "local-read",
  "connector-read",
  "web-fetch",
  "browser-read",
  "cache-read"
]);

const TRUSTED_ALLOWED = new Set<PermissionEffect>([
  ...READ_ONLY_ALLOWED,
  "local-write",
  "connector-write",
  "browser-state-mutation",
  "app-state-mutation",
  "delete",
  "publish-external",
  "memory-promotion"
]);

const HIGH_SEVERITY_EFFECTS = new Set<PermissionEffect>([
  "delete",
  "shell-execution",
  "connector-write",
  "publish-external",
  "cache-mutation",
  "memory-promotion",
  "browser-state-mutation"
]);

const CONSEQUENTIAL_EFFECTS = new Set<PermissionEffect>([
  "local-write",
  "app-state-mutation",
  ...HIGH_SEVERITY_EFFECTS
]);

const HIGH_RISKS = new Set<ApprovalRiskLevel>(["high", "critical"]);

export function permissionProfileForMode(mode: PermissionMode): PermissionProfileId {
  return PROFILE_FOR_MODE[mode];
}

export function permissionModeForProfile(profile: PermissionProfileId): PermissionMode {
  return MODE_FOR_PROFILE[profile];
}

export function normalizePermissionProfile(input: {
  mode?: PermissionMode;
  profile?: PermissionProfileId;
}): { mode: PermissionMode; profile: PermissionProfileId } {
  if (input.profile) {
    return {
      profile: input.profile,
      mode: MODE_FOR_PROFILE[input.profile]
    };
  }
  const mode = input.mode ?? "read-only";
  return {
    mode,
    profile: PROFILE_FOR_MODE[mode]
  };
}

export function effectForTool(toolName: string): PermissionEffect | null {
  switch (toolName) {
    case "teammate-assign":
    case "project-record":
    case "team-await-user":
      return "coordination";
    case "read-file":
    case "computer-artifact":
      return "local-read";
    case "write-file":
    case "create-spreadsheet":
    case "create-document":
    case "generate-image":
    case "edit-image":
      return "local-write";
    case "run-shell":
      return "shell-execution";
    case "web-fetch":
      return "web-fetch";
    case "local-app-observe":
    case "local-app-list":
    case "local-app-select":
    case "local-desktop-observe":
      return "browser-read";
    case "local-app-action":
    case "local-desktop-action":
    case "cloud-browser":
    case "cloud-browser-action":
      return "browser-state-mutation";
    case "connection-read":
    case "connector-tools":
    case "github-read":
    case "plugin-read":
    case "vercel-read":
    case "linear-read":
    case "google-drive-read":
    case "gmail-read":
    case "google-calendar-read":
    case "search-notion":
    case "search-slack":
      return "connector-read";
    case "connector-call":
    case "connector-action":
      return "connector-write";
    default:
      return null;
  }
}

const CONNECTOR_DELETE_ACTIONS = new Set<string>([
  "google-drive.delete-file",
  "notion.delete-block",
  "slack.delete",
  "google-calendar.delete-event",
  "vercel.delete-domain"
]);

const CONNECTOR_PUBLISH_ACTIONS = new Set<string>([
  "gmail.send",
  "slack.post",
  "slack.reply",
  "slack.edit",
  "notion.create-comment",
  "github.comment",
  "github.create-review",
  "github.create-issue",
  "github.update-issue",
  "github.update-file",
  "github.create-branch",
  "github.dispatch-workflow",
  "google-drive.share-file",
  "vercel.promote",
  "vercel.rollback",
  "google-calendar.cancel-event"
]);

export function effectForConnectorAction(action: string): PermissionEffect {
  if (CONNECTOR_DELETE_ACTIONS.has(action)) return "delete";
  if (CONNECTOR_PUBLISH_ACTIONS.has(action)) return "publish-external";
  return "connector-write";
}

export function effectForBrowserAction(action: string): PermissionEffect | null {
  switch (action) {
    case "browser.read-url":
    case "browser.read-title":
      return "browser-read";
    case "browser.download":
      return "local-write";
    case "browser.submit":
    case "browser.upload":
    case "browser.clipboard-write":
      return "publish-external";
    case "browser.navigate":
    case "browser.click":
    case "browser.type":
    case "browser.select":
    case "browser.screenshot":
    case "browser.clipboard-read":
      return "browser-state-mutation";
    default:
      return null;
  }
}

export function isHighSeverityEffect(effect: PermissionEffect): boolean {
  return HIGH_SEVERITY_EFFECTS.has(effect);
}

export function evaluatePermissionPolicy(input: PermissionPolicyInput): PermissionPolicyDecision {
  const { mode, profile } = normalizePermissionProfile(input);
  const riskLevel = input.riskLevel ?? "low";
  const effect = input.effect;

  if (profile === "read-only" && !READ_ONLY_ALLOWED.has(effect)) {
    return {
      profile,
      mode,
      effect,
      allowed: false,
      approvalRequired: false,
      reason: "Read-only only permits safe local, connector, cache, and web reads."
    };
  }

  if (profile === "trusted" && !TRUSTED_ALLOWED.has(effect)) {
    return {
      profile,
      mode,
      effect,
      allowed: false,
      approvalRequired: false,
      reason: "Trusted profile blocks shell execution and cache mutation."
    };
  }

  const approvalRequired =
    CONSEQUENTIAL_EFFECTS.has(effect) || effect === "web-fetch" || HIGH_RISKS.has(riskLevel);

  return {
    profile,
    mode,
    effect,
    allowed: true,
    approvalRequired,
    reason: approvalRequired
      ? "This action is allowed only through the approval and audit boundary."
      : "This read-like action is allowed by the active permission profile."
  };
}

export const DEFAULT_CUSTOM_APPROVAL_SETTINGS: CustomApprovalSettings = {
  allowSmallLocalEdits: false,
  allowPowerfulCommands: false
};

export function normalizeCustomApprovalSettings(
  input: Partial<CustomApprovalSettings> | undefined | null
): CustomApprovalSettings {
  return { ...DEFAULT_CUSTOM_APPROVAL_SETTINGS, ...(input ?? {}) };
}

export function resolvePermissionModeFromCustom(
  settings: CustomApprovalSettings
): PermissionMode {
  if (settings.allowPowerfulCommands) {
    return "full-access";
  }
  if (settings.allowSmallLocalEdits) {
    return "trusted-scope";
  }
  return "read-only";
}

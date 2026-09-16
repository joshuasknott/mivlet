import type {
  ApprovalRiskLevel,
  CustomApprovalSettings,
  PermissionMode,
  PermissionProfileId
} from "@mivlet/protocol";
import vocabulary from "./permission-policy.json" with { type: "json" };

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

const PROFILE_FOR_MODE = vocabulary.profileForMode as Record<PermissionMode, PermissionProfileId>;

const MODE_FOR_PROFILE = Object.fromEntries(
  Object.entries(PROFILE_FOR_MODE).map(([mode, profile]) => [profile, mode])
) as Record<PermissionProfileId, PermissionMode>;

const READ_ONLY_ALLOWED = new Set<PermissionEffect>(
  vocabulary.readOnlyAllowed as PermissionEffect[]
);
const TRUSTED_ALLOWED = new Set<PermissionEffect>(
  vocabulary.trustedAllowed as PermissionEffect[]
);
const HIGH_SEVERITY_EFFECTS = new Set<PermissionEffect>(
  vocabulary.highSeverityEffects as PermissionEffect[]
);
const CONSEQUENTIAL_EFFECTS = new Set<PermissionEffect>(
  vocabulary.consequentialEffects as PermissionEffect[]
);
const HIGH_RISKS = new Set<ApprovalRiskLevel>(vocabulary.highRisks as ApprovalRiskLevel[]);
const TOOL_EFFECTS = vocabulary.toolEffects as Record<string, PermissionEffect>;
const CONNECTOR_DELETE_ACTIONS = new Set<string>(vocabulary.connectorDeleteActions);
const CONNECTOR_PUBLISH_ACTIONS = new Set<string>(vocabulary.connectorPublishActions);
const BROWSER_ACTION_EFFECTS = vocabulary.browserActionEffects as Record<string, PermissionEffect>;

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
  return TOOL_EFFECTS[toolName] ?? null;
}

export function effectForConnectorAction(action: string): PermissionEffect {
  if (CONNECTOR_DELETE_ACTIONS.has(action)) return "delete";
  if (CONNECTOR_PUBLISH_ACTIONS.has(action)) return "publish-external";
  return "connector-write";
}

export function effectForBrowserAction(action: string): PermissionEffect | null {
  return BROWSER_ACTION_EFFECTS[action] ?? null;
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
      reason: vocabulary.reasons.readOnlyDenied
    };
  }

  if (profile === "trusted" && !TRUSTED_ALLOWED.has(effect)) {
    return {
      profile,
      mode,
      effect,
      allowed: false,
      approvalRequired: false,
      reason: vocabulary.reasons.trustedDenied
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
      ? vocabulary.reasons.approvalRequired
      : vocabulary.reasons.readLikeAllowed
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

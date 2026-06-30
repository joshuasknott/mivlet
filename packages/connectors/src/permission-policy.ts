import type { ApprovalRiskLevel, PermissionMode, PermissionProfileId } from "@fable/protocol";

export type PermissionEffect =
  | "local-read"
  | "local-write"
  | "shell-execution"
  | "web-fetch"
  | "connector-read"
  | "connector-write"
  | "cache-read"
  | "cache-mutation"
  | "app-state-mutation"
  | "schedule-mutation"
  | "schedule-execution";

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
  "local-read",
  "connector-read",
  "web-fetch",
  "cache-read"
]);

const TRUSTED_ALLOWED = new Set<PermissionEffect>([
  ...READ_ONLY_ALLOWED,
  "local-write",
  "connector-write",
  "app-state-mutation",
  "schedule-mutation",
  "schedule-execution"
]);

const CONSEQUENTIAL_EFFECTS = new Set<PermissionEffect>([
  "local-write",
  "shell-execution",
  "connector-write",
  "cache-mutation",
  "app-state-mutation",
  "schedule-mutation",
  "schedule-execution"
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
    case "read-file":
      return "local-read";
    case "write-file":
      return "local-write";
    case "run-shell":
      return "shell-execution";
    case "web-fetch":
      return "web-fetch";
    case "github-read":
    case "vercel-read":
    case "linear-read":
    case "google-drive-read":
    case "gmail-read":
    case "google-calendar-read":
    case "search-notion":
    case "search-slack":
      return "connector-read";
    default:
      return null;
  }
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

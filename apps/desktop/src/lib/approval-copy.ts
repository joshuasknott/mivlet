import type {
  ApprovalDecision,
  ApprovalGrant,
  ApprovalRequest,
  ApprovalRiskLevel,
  PermissionMode
} from "@mivlet/protocol";
import {
  permissionDescriptionFor,
  permissionLabelFor
} from "./agent-run";

/**
 * Single source of plain, non-technical copy for the approvals UX. Keeping the
 * labels and sentences here (pure functions, no React) lets the panel render
 * deterministic copy and lets the tests assert it directly.
 *
 * SECURITY NOTE: no helper here may imply that a saved rule, session grant, or
 * typed confirmation makes an action safe or bypasses execution-boundary
 * checks. The execution boundary still rechecks each consequential action
 * (fingerprinted one-time permit); the UI copy only describes what Mivlet asks
 * before an action runs.
 */

/** Plain, user-facing labels for each approval decision. */
export const DECISION_LABELS: Record<ApprovalDecision, string> = {
  once: "Approve once",
  session: "Allow for this session",
  rule: "Save as rule",
  modify: "Modify",
  deny: "Deny"
};

/** Plain label for a single decision value. */
export function decisionLabel(decision: ApprovalDecision): string {
  return DECISION_LABELS[decision];
}

/** Plain description of what each decision does, for tooltips/labels. */
export function decisionDescription(decision: ApprovalDecision): string {
  switch (decision) {
    case "once":
      return "Let Mivlet do this one time. It will ask again the next time.";
    case "session":
      return "Let Mivlet do this for the rest of this session without asking again.";
    case "rule":
      return (
        "Remember this so Mivlet can do it again without asking. Each consequential " +
        "action is still checked before it runs."
      );
    case "modify":
      return "Narrow what Mivlet can do before you approve it.";
    case "deny":
      return "Stop. Mivlet won't run this action.";
    default:
      return "";
  }
}

const RISK_LABELS: Record<ApprovalRiskLevel, string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
  critical: "Critical risk"
};

/** Plain risk label, e.g. "High risk". */
export function riskLabel(level: ApprovalRiskLevel): string {
  return RISK_LABELS[level];
}

/** Stable tone token used to style the risk badge (never user-facing copy). */
export function riskTone(level: ApprovalRiskLevel): ApprovalRiskLevel {
  return level;
}

const SERVICE_TITLECASE: Record<string, string> = {
  "local-files": "Local Files"
};

/** Turn a raw service id into a readable product name. */
export function serviceLabel(service: string): string {
  if (SERVICE_TITLECASE[service]) {
    return SERVICE_TITLECASE[service];
  }
  return service
    .split(/[-_]/)
    .map((word) => (word.length === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join(" ");
}

/** Plain profile label for a permission mode (reuses the composer vocabulary). */
export function profileLabel(mode: PermissionMode): string {
  return permissionLabelFor(mode);
}

/** Plain profile description for a permission mode. */
export function profileDescription(mode: PermissionMode): string {
  return permissionDescriptionFor(mode);
}

/** Whether a mode/risk combination is treated as high-risk (needs typed phrase). */
export function isHighRisk(
  mode: PermissionMode | undefined,
  riskLevel: ApprovalRiskLevel | undefined
): boolean {
  return mode === "full-access" || riskLevel === "high" || riskLevel === "critical";
}

/** Short action summary: "Service · Action". */
export function actionSummary(approval: ApprovalRequest): string {
  return `${serviceLabel(approval.service)} · ${approval.action}`;
}

/**
 * Plain explanation of why approval is needed. Escalates for high-risk or
 * hard-to-undo actions; otherwise states Mivlet asks before running.
 */
export function whyApprovalIsNeeded(approval: ApprovalRequest): string {
  const high = isHighRisk(approval.mode, approval.riskLevel);
  if (approval.riskLevel === "critical") {
    return "This is a consequential action that can't be undone, so Mivlet asks you first.";
  }
  if (high) {
    return "This action is hard to undo, so Mivlet checks with you before it runs.";
  }
  return "Mivlet asks before taking an action that touches your data or a service.";
}

/** A modify draft shape, mirrored from the panel's local edit state. */
export interface ModificationDraftInput {
  mode: PermissionMode;
  dataUsed: string;
  consequence: string;
}

/**
 * Build a plain preview of a narrowed modify draft so the user sees the
 * resulting scope before they save. Mirrors the action summary format but uses
 * the modified fields.
 */
export function modifiedSummary(draft: ModificationDraftInput): string {
  const dataText = draft.dataUsed.trim() || "no data listed";
  const consequenceText = draft.consequence.trim() || "no consequence listed";
  return `${profileLabel(draft.mode)} · ${dataText} · ${consequenceText}`;
}

/** Format an ISO timestamp into a readable local-ish date string. */
function formatCreated(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  // Locale-stable YYYY-MM-DD so the test and UI agree regardless of machine.
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Inspectable summary of an active grant or saved rule. Names the scope
 * (session/saved rule), service, action, profile, and created time.
 */
export function grantSummary(grant: ApprovalGrant): string {
  const scope = grant.scope === "rule" ? "Saved rule" : "Session";
  const when = grant.createdAt ? ` · added ${formatCreated(grant.createdAt)}` : "";
  return `${scope}: ${serviceLabel(grant.service)} · ${grant.action} · ${profileLabel(grant.mode)}${when}`;
}

/** Structured explanation for the high-risk confirmation step. */
export interface HighRiskExplanation {
  /** The exact phrase the user must type. */
  requiredPhrase: string;
  /** Plain sentence describing what confirming unlocks. */
  whatItUnlocks: string;
  /** Plain note explaining the typed-phrase requirement (never "this is safe"). */
  note: string;
}

/**
 * Explain the high-risk confirmation: the required phrase and what confirming
 * unlocks, in plain words. Never implies typing the phrase makes the action safe.
 */
export function highRiskExplanation(
  approval: ApprovalRequest,
  decision: ApprovalDecision
): HighRiskExplanation {
  const phrase = approval.confirmationPhrase ?? "";
  const label = decisionLabel(decision).toLowerCase();
  const whatItUnlocks = `Confirming runs the action as "${label}" after Mivlet's final check.`;
  const note =
    "This action is high-risk, so type the exact phrase below. " +
    "Mivlet then confirms in a system dialog before minting the one-time permit. " +
    "Repeating the phrase from this window cannot authorize it.";
  return {
    requiredPhrase: phrase,
    whatItUnlocks,
    note
  };
}

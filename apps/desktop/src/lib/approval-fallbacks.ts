import type {
  ApprovalGrant,
  ApprovalResolutionRequest,
  ApprovalResolutionResponse
} from "@mivlet/protocol";
import { toSlug } from "./helpers";

/**
 * In-browser approval fallback used when the Tauri runtime is unavailable
 * (for example, in the browser dev server or vitest). Echoed confirmation
 * phrases cannot stand in for a native mint; omitting them is preview-only.
 */

export function webviewEchoedConfirmation(
  confirmationText: string | undefined,
  confirmationPhrase: string | undefined
): boolean {
  const provided = confirmationText?.trim() ?? "";
  const expected = confirmationPhrase?.trim() ?? "";
  return provided.length > 0 && expected.length > 0 && provided === expected;
}

export function resolveApprovalFallback(request: ApprovalResolutionRequest): ApprovalResolutionResponse {
  if (!request.request.decisions.includes(request.decision)) {
    throw new Error("Approval decision is not available for this request.");
  }

  const effectiveRequest =
    request.decision === "modify" && request.modification
      ? {
          ...request.request,
          mode: request.modification.mode,
          dataUsed: request.modification.dataUsed,
          consequence: request.modification.consequence
        }
      : request.request;
  const approving = ["once", "session", "rule", "modify"].includes(request.decision);
  const highRisk =
    effectiveRequest.mode === "full-access" ||
    effectiveRequest.riskLevel === "high" ||
    effectiveRequest.riskLevel === "critical";

  if (request.decision === "modify" && !request.modification) {
    throw new Error("Modified approvals need a narrowed permission scope.");
  }
  if (approving && highRisk) {
    if (!effectiveRequest.confirmationPhrase) {
      throw new Error("High-risk approvals need a confirmation phrase.");
    }
    if (webviewEchoedConfirmation(request.confirmationText, effectiveRequest.confirmationPhrase)) {
      throw new Error("WebView cannot mint a high-risk permit by echoing the confirmation phrase.");
    }
  }

  const grant: ApprovalGrant | undefined =
    request.decision === "session" || request.decision === "rule"
      ? {
          id: `approval-${request.decision}-${toSlug(`${effectiveRequest.service}-${effectiveRequest.action}`)}`,
          requestId: effectiveRequest.id,
          scope: request.decision,
          service: effectiveRequest.service,
          action: effectiveRequest.action,
          mode: effectiveRequest.mode,
          dataUsed: effectiveRequest.dataUsed,
          createdAt: request.decidedAt
        }
      : undefined;
  const note =
    request.decision === "modify"
      ? `${effectiveRequest.service} ${effectiveRequest.action} modified to ${effectiveRequest.mode} using ${effectiveRequest.dataUsed.join(", ")}`
      : `${effectiveRequest.service} ${effectiveRequest.action}`;

  return {
    persisted: false,
    effectiveRequest,
    dismissed: true,
    grant,
    auditEntry: {
      id: `${effectiveRequest.id}-${request.decision}-${toSlug(request.decidedAt)}`,
      requestId: effectiveRequest.id,
      decision: request.decision,
      decidedAt: request.decidedAt,
      note
    }
  };
}

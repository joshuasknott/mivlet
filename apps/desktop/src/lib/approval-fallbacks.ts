import type {
  ApprovalGrant,
  ApprovalModification,
  ApprovalResolutionRequest,
  ApprovalResolutionResponse,
  MemoryControlState,
  MemoryPromotionRequest,
  MemoryRecord
} from "@fable/protocol";
import { toSlug } from "./helpers";

/**
 * In-browser fallbacks for the approval and memory runtime commands.
 * These mirror the Rust runtime logic and are used when the Tauri runtime is
 * unavailable (for example, in the browser dev server or vitest).
 */

export function encodeMemoryExportFallback(state: MemoryControlState) {
  return JSON.stringify(
    {
      // Compatibility contract: existing export consumers identify this exact
      // format string, so the product rename must not silently break them.
      format: "arden.memory.export.v1",
      disabled: state.disabled,
      records: state.records
    },
    null,
    2
  );
}

export function promoteKnowledgeSourceFallback(request: MemoryPromotionRequest) {
  if (!["once", "session", "rule"].includes(request.decision)) {
    throw new Error("Memory promotion requires once, session, or rule approval.");
  }

  if (request.state.disabled) {
    throw new Error("Memory is disabled.");
  }

  const source = request.source;
  const trust = source.trust ?? "untrusted";
  const record: MemoryRecord = {
    id: `memory-from-${toSlug(source.id)}`,
    kind: "imported",
    title: source.title,
    value:
      source.contentPreview?.trim() ||
      `${source.title} from ${source.provenance}. Freshness: ${source.freshness}.`,
    source:
      trust === "untrusted"
        ? `Approved from untrusted source: ${source.provenance}`
        : `Approved from trusted source: ${source.provenance}`,
    freshness: "Approved now",
    approved: true,
    pinned: true
  };
  const state: MemoryControlState = {
    disabled: false,
    records: [record, ...request.state.records.filter((current) => current.id !== record.id)]
  };

  return {
    persisted: false,
    record,
    state,
    auditEntry: {
      id: `memory-promotion-${toSlug(source.id)}-${toSlug(request.decidedAt)}`,
      requestId: `memory-promotion-${source.id}`,
      decision: request.decision,
      decidedAt: request.decidedAt,
      note: `Fable Memory Approve ${source.provenance} into durable memory`
    }
  };
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
    if (request.confirmationText?.trim() !== effectiveRequest.confirmationPhrase) {
      throw new Error("Confirmation phrase did not match.");
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

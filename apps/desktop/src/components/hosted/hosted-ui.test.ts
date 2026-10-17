import { expect, it } from "vitest";
import type { ApprovalRequest, ApprovalResolutionResponse } from "@mivlet/protocol";
import { matchesHostedApproval } from "./hosted-ui";

const request: ApprovalRequest = {
  id: "request", service: "hosted-repository", action: "import", mode: "read-only",
  permissionProfile: "read-only", riskLevel: "high", dataUsed: ["reviewed files"],
  consequence: "Import only the reviewed changes", requestedAt: "2026-10-17T00:00:00Z",
  decisions: ["once", "deny"], confirmationPhrase: "IMPORT",
};
const response = (): ApprovalResolutionResponse => ({
  persisted: true, dismissed: true, effectiveRequest: structuredClone(request),
  auditEntry: { id: "audit", requestId: request.id, decision: "once", decidedAt: "2026-10-17T00:00:01Z", note: "Approved" },
});

it("accepts only persisted one-time approval for the complete reviewed request", () => {
  expect(matchesHostedApproval(request, response())).toBe(true);
  expect(matchesHostedApproval(request, null)).toBe(false);
  const missing = response(); missing.persisted = false;
  expect(matchesHostedApproval(request, missing)).toBe(false);
  const decision = response(); decision.auditEntry.decision = "session";
  expect(matchesHostedApproval(request, decision)).toBe(false);
  const identity = response(); identity.auditEntry.requestId = "other";
  expect(matchesHostedApproval(request, identity)).toBe(false);
  const grant = response(); grant.grant = { id: "grant", requestId: "other", scope: "session", service: request.service, action: request.action, mode: request.mode, dataUsed: request.dataUsed, createdAt: request.requestedAt };
  expect(matchesHostedApproval(request, grant)).toBe(false);
});

it.each<Partial<ApprovalRequest>>([
  { id: "other" }, { service: "other" }, { action: "other" }, { mode: "full-access" },
  { permissionProfile: "full-with-approvals" }, { riskLevel: "low" }, { dataUsed: ["other files"] },
  { consequence: "Different changes" }, { requestedAt: "2026-10-17T00:00:02Z" },
  { decisions: ["session"] }, { confirmationPhrase: "DIFFERENT" },
])("rejects a changed approval field: %j", changed => {
  const recorded = response();
  Object.assign(recorded.effectiveRequest, changed);
  expect(matchesHostedApproval(request, recorded)).toBe(false);
});

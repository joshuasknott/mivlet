import { describe, expect, it } from "vitest";
import type { ApprovalRequest, ApprovalResolutionRequest } from "@fable/protocol";
import { resolveApprovalFallback, webviewEchoedConfirmation } from "./approval-fallbacks";

function highRiskRequest(): ApprovalRequest {
  return {
    id: "approval-1",
    service: "Mivlet tools",
    action: "write-file a.txt",
    mode: "full-access",
    riskLevel: "high",
    dataUsed: ["path", "content"],
    consequence: "Writes a workspace file.",
    requestedAt: "2026-06-27T12:00:00Z",
    decisions: ["once", "deny"],
    confirmationPhrase: "write file"
  };
}

function resolution(
  confirmationText?: string
): ApprovalResolutionRequest {
  return {
    request: highRiskRequest(),
    decision: "once",
    decidedAt: "2026-06-27T12:00:01Z",
    ...(confirmationText === undefined ? {} : { confirmationText })
  };
}

describe("approval fallback mint fence", () => {
  it("treats copied confirmation phrases as WebView echo", () => {
    expect(webviewEchoedConfirmation("write file", "write file")).toBe(true);
    expect(webviewEchoedConfirmation("  write file  ", "write file")).toBe(true);
    expect(webviewEchoedConfirmation(undefined, "write file")).toBe(false);
    expect(webviewEchoedConfirmation("other", "write file")).toBe(false);
  });

  it("refuses to resolve a high-risk approval by echoing the phrase", () => {
    expect(() => resolveApprovalFallback(resolution("write file"))).toThrow(
      /echoing the confirmation phrase/i
    );
  });

  it("allows omitted confirmation text as a non-persisted preview", () => {
    const response = resolveApprovalFallback(resolution());
    expect(response.persisted).toBe(false);
    expect(response.auditEntry.decision).toBe("once");
  });
});

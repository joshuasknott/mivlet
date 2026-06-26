import { describe, expect, it } from "vitest";
import { buildToolApproval } from "./approvals";

describe("buildToolApproval", () => {
  it("shapes a read-only tool into a read-only, low-risk approval", () => {
    const approval = buildToolApproval("openai", "read-file", '{"path":"a.md"}');
    expect(approval.service).toBe("openai");
    expect(approval.action).toContain("read-file");
    expect(approval.mode).toBe("read-only");
    expect(approval.riskLevel).toBe("low");
    expect(approval.dataUsed).toContain("path: a.md");
    expect(approval.confirmationPhrase).toBeUndefined();
  });

  it("shapes a write tool into full-access, high-risk requiring confirmation", () => {
    const approval = buildToolApproval("anthropic", "write-file", '{"path":"a.md","content":"x"}');
    expect(approval.mode).toBe("full-access");
    expect(approval.riskLevel).toBe("high");
    expect(approval.confirmationPhrase).toBe("approve write-file");
  });

  it("shapes a shell tool into full-access, critical risk", () => {
    const approval = buildToolApproval("xai", "run-shell", '{"command":"ls"}');
    expect(approval.riskLevel).toBe("critical");
    expect(approval.mode).toBe("full-access");
  });

  it("fails closed for an unregistered tool — critical risk, refusal consequence", () => {
    const approval = buildToolApproval("gemini", "delete-everything", "{}");
    expect(approval.riskLevel).toBe("critical");
    expect(approval.mode).toBe("full-access");
    expect(approval.consequence.toLowerCase()).toContain("unregistered");
    expect(approval.confirmationPhrase).toBe("approve delete-everything");
  });

  it("survives malformed JSON arguments without throwing", () => {
    const approval = buildToolApproval("openai", "read-file", "not-json");
    expect(approval.dataUsed).toContain("raw: not-json");
  });
});

import type {
  ApprovalDecision,
  ApprovalGrant,
  ApprovalRequest,
  ApprovalRiskLevel,
  PermissionMode
} from "@fable/protocol";
import { describe, expect, it } from "vitest";
import {
  DECISION_LABELS,
  actionSummary,
  decisionLabel,
  decisionDescription,
  grantSummary,
  highRiskExplanation,
  modifiedSummary,
  profileDescription,
  profileLabel,
  riskLabel,
  riskTone,
  serviceLabel,
  whyApprovalIsNeeded
} from "./approval-copy";

/**
 * Pure-copy coverage for the smoother approvals UX. The helpers are the single
 * source of the user-facing permission language, so they are unit-tested in
 * isolation (no React, no DOM) to keep the labels deterministic and plain.
 */

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "approval-1",
    service: "google-drive",
    action: "Delete file launch-plan.md",
    mode: "full-access",
    riskLevel: "high",
    dataUsed: ["file: launch-plan.md"],
    consequence: "Permanently deletes a Google Drive file.",
    requestedAt: "2026-06-30T00:00:00.000Z",
    decisions: ["once", "session", "rule", "modify", "deny"],
    confirmationPhrase: "approve delete file launch-plan.md",
    ...overrides
  };
}

describe("approval-copy — plain decision labels", () => {
  const all: ApprovalDecision[] = ["once", "session", "rule", "modify", "deny"];

  it("uses the exact plain labels required by the approvals UX", () => {
    expect(DECISION_LABELS.once).toBe("Approve once");
    expect(DECISION_LABELS.session).toBe("Allow for this session");
    expect(DECISION_LABELS.rule).toBe("Save as rule");
    expect(DECISION_LABELS.modify).toBe("Modify");
    expect(DECISION_LABELS.deny).toBe("Deny");
  });

  it("exposes a plain label for every decision value", () => {
    for (const decision of all) {
      expect(decisionLabel(decision)).toBe(DECISION_LABELS[decision]);
      expect(decisionLabel(decision).length).toBeGreaterThan(0);
    }
  });

  it("pairs each label with a plain, non-technical description", () => {
    for (const decision of all) {
      const description = decisionDescription(decision);
      expect(description.length).toBeGreaterThan(0);
    }
  });

  it("does not promise saved rules bypass execution-boundary checks", () => {
    // Requirement: do not imply saved rules bypass execution-boundary checks
    // for high-risk writes. The rule description must state each consequential
    // action is still checked before it runs.
    expect(decisionDescription("rule")).toMatch(/still checked before/i);
  });

  it("makes deny clearly stop the action without promising it runs", () => {
    expect(decisionDescription("deny").toLowerCase()).toMatch(/not run|stop|won't run/);
  });
});

describe("approval-copy — risk + profile labels", () => {
  it("labels every risk level in plain words", () => {
    const levels: ApprovalRiskLevel[] = ["low", "medium", "high", "critical"];
    for (const level of levels) {
      expect(riskLabel(level)).toMatch(/risk/i);
    }
    expect(riskLabel("high")).toBe("High risk");
    expect(riskLabel("critical")).toBe("Critical risk");
  });

  it("maps each risk level to a stable tone token for styling", () => {
    expect(riskTone("low")).toBe("low");
    expect(riskTone("medium")).toBe("medium");
    expect(riskTone("high")).toBe("high");
    expect(riskTone("critical")).toBe("critical");
  });

  it("polishes raw service ids into readable names", () => {
    expect(serviceLabel("google-drive")).toBe("Google Drive");
    expect(serviceLabel("gmail")).toBe("Gmail");
    expect(serviceLabel("local-files")).toBe("Local Files");
  });

  it("maps each permission mode to a plain profile label and description", () => {
    const modes: PermissionMode[] = ["read-only", "trusted-scope", "full-access"];
    for (const mode of modes) {
      expect(profileLabel(mode).length).toBeGreaterThan(0);
      expect(profileDescription(mode).length).toBeGreaterThan(0);
    }
    // Full access must read as the broadest profile, never as "safe".
    expect(profileDescription("full-access").toLowerCase()).not.toMatch(/safe|read.?only/);
  });
});

describe("approval-copy — card copy", () => {
  it("builds a short action summary that names the service and the action", () => {
    expect(actionSummary(approval())).toBe("Google Drive · Delete file launch-plan.md");
  });

  it("explains why approval is needed, escalating for high-risk actions", () => {
    const high = whyApprovalIsNeeded(approval({ riskLevel: "critical", mode: "full-access" }));
    expect(high.toLowerCase()).toMatch(/hard|undo|cannot be undone|risk/);

    const write = whyApprovalIsNeeded(
      approval({ riskLevel: "medium", mode: "trusted-scope" })
    );
    // A trusted-scope external action: the explanation should still say Fable
    // asks before it runs.
    expect(write.toLowerCase()).toMatch(/ask|check/);
  });
});

describe("approval-copy — modify preview", () => {
  it("summarizes a narrowed modify draft in plain words before saving", () => {
    const summary = modifiedSummary({
      mode: "read-only",
      dataUsed: "file: safer.md",
      consequence: "Reads a single file."
    });
    // The preview must surface the narrowed permission + data + consequence.
    expect(summary).toMatch(/Read.?only|Confirm every action/i);
    expect(summary).toContain("file: safer.md");
    expect(summary).toContain("Reads a single file.");
  });
});

describe("approval-copy — grant + rule inspection", () => {
  const sessionGrant: ApprovalGrant = {
    id: "grant-1",
    requestId: "approval-1",
    scope: "session",
    service: "google-drive",
    action: "Read file launch-plan.md",
    mode: "read-only",
    dataUsed: ["file: launch-plan.md"],
    createdAt: "2026-06-30T09:00:00.000Z"
  };

  it("summarizes an active session grant with service/action/mode and created time", () => {
    const summary = grantSummary(sessionGrant);
    expect(summary).toMatch(/Google Drive/i);
    expect(summary).toMatch(/Read file launch-plan.md/);
    expect(summary).toMatch(/read.?only|confirm every action/i);
    expect(summary).toMatch(/session/i);
    expect(summary).toMatch(/2026/);
  });

  it("summarizes a saved rule distinctly from a session grant", () => {
    const ruleSummary = grantSummary({ ...sessionGrant, scope: "rule" });
    expect(ruleSummary.toLowerCase()).toMatch(/rule|saved/);
  });
});

describe("approval-copy — high-risk confirmation", () => {
  it("explains the required phrase and what confirming unlocks", () => {
    const explanation = highRiskExplanation(approval(), "session");
    expect(explanation.requiredPhrase).toBe("approve delete file launch-plan.md");
    expect(explanation.whatItUnlocks.length).toBeGreaterThan(0);
    // The explanation must make clear this is a high-risk action requiring the
    // exact typed phrase, and must not promise the phrase makes it safe.
    expect(explanation.note.toLowerCase()).toMatch(/type|exact phrase/);
    expect(explanation.note.toLowerCase()).not.toMatch(/this is safe|guaranteed safe/);
  });
});

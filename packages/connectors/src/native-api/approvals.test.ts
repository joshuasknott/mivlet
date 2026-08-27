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

  it("canonicalizes a cloud-browser page and requires critical confirmation", () => {
    const approval = buildToolApproval(
      "openai",
      "cloud-browser",
      '{"url":"https://example.com/path#section"}'
    );
    expect(approval.mode).toBe("full-access");
    expect(approval.riskLevel).toBe("critical");
    expect(approval.dataUsed).toEqual(["url: https://example.com/path"]);
    expect(approval.confirmationPhrase).toBe("approve cloud-browser");
  });

  it("binds an on-device browser page to a critical one-time confirmation", () => {
    const approval = buildToolApproval(
      "openai",
      "local-browser",
      '{"url":"https://example.com/path#section"}'
    );
    expect(approval).toMatchObject({
      mode: "full-access",
      riskLevel: "critical",
      dataUsed: ["url: https://example.com/path"],
      confirmationPhrase: "approve local-browser"
    });
    expect(approval.consequence).not.toMatch(/unregistered/i);
  });

  it("binds every local browser control field and treats observation as a read", () => {
    const observation = buildToolApproval("openai", "local-browser-observe", "{}");
    expect(observation).toMatchObject({ mode: "read-only", riskLevel: "medium" });
    expect(observation.confirmationPhrase).toBeUndefined();

    const action = buildToolApproval("openai", "local-browser-action", JSON.stringify({
      action: "fill",
      observationId: "observation-1234567890abcdef",
      elementRef: "control-1234567890abcdef-0",
      controlRole: "textbox",
      controlName: "Search",
      value: "Fable"
    }));
    expect(action).toMatchObject({
      mode: "full-access",
      riskLevel: "critical",
      confirmationPhrase: "approve local-browser-action"
    });
    expect(action.dataUsed).toEqual([
      "action: fill",
      "observationId: observation-1234567890abcdef",
      "elementRef: control-1234567890abcdef-0",
      "controlRole: textbox",
      "controlName: Search",
      "value: Fable"
    ]);
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

  it("binds every browser control argument shown to the user", () => {
    const approval = buildToolApproval("openai", "cloud-browser-action", JSON.stringify({
      action: "fill",
      observationId: "observation-1234567890abcdef",
      elementRef: "control-1234567890abcdef-1",
      controlRole: "textbox",
      controlName: "Search",
      value: "quarterly plan"
    }));

    expect(approval.dataUsed).toEqual([
      "action: fill",
      "observationId: observation-1234567890abcdef",
      "elementRef: control-1234567890abcdef-1",
      "controlRole: textbox",
      "controlName: Search",
      "value: quarterly plan"
    ]);
  });

  it("treats a hosted process schedule as registered critical work", () => {
    const approval = buildToolApproval("openai", "cloud-process-schedule", JSON.stringify({
      scheduleId: "schedule-digest-123",
      runId: "scheduled-digest",
      argv: ["node", "digest.mjs"],
      firstRunAt: "2026-08-25T18:00:00.000Z",
      intervalSeconds: 3600
    }));
    expect(approval).toMatchObject({
      mode: "full-access",
      riskLevel: "critical",
      confirmationPhrase: "approve cloud-process-schedule"
    });
    expect(approval.consequence).not.toMatch(/unregistered/i);
    expect(approval.dataUsed).toContain("argv: [\"node\",\"digest.mjs\"]");
  });

  it("treats hosted schedule cancellation as an exact critical action", () => {
    const approval = buildToolApproval(
      "openai",
      "cloud-process-schedule-cancel",
      '{"scheduleId":"schedule-digest-123"}'
    );
    expect(approval).toMatchObject({
      mode: "full-access",
      riskLevel: "critical",
      dataUsed: ["scheduleId: schedule-digest-123"],
      confirmationPhrase: "approve cloud-process-schedule-cancel"
    });
    expect(approval.consequence).not.toMatch(/unregistered/i);
  });

  it("treats an always-on agent routine and its standing capabilities as registered critical work", () => {
    const approval = buildToolApproval("openai", "cloud-agent-routine", JSON.stringify({
      routineId: "routine-research-digest-123",
      runId: "routine-research-digest",
      title: "Research digest",
      instruction: "Review workspace notes and write a concise digest.",
      firstRunAt: "2026-08-26T18:00:00.000Z",
      intervalSeconds: 86_400,
      capabilities: ["workspace-read", "workspace-write"],
      maxSteps: 6
    }));
    expect(approval).toMatchObject({
      mode: "full-access",
      riskLevel: "critical",
      confirmationPhrase: "approve cloud-agent-routine"
    });
    expect(approval.consequence).not.toMatch(/unregistered/i);
    expect(approval.dataUsed).toEqual(expect.arrayContaining([
      "routineId: routine-research-digest-123",
      "title: Research digest",
      "capabilities: [\"workspace-read\",\"workspace-write\"]",
      "maxSteps: 6"
    ]));
  });

  it("treats routine pause, resume, and cancellation as exact critical actions", () => {
    for (const tool of [
      "cloud-agent-routine-pause",
      "cloud-agent-routine-resume",
      "cloud-agent-routine-cancel"
    ]) {
      const approval = buildToolApproval(
        "openai",
        tool,
        '{"routineId":"routine-research-digest-123"}'
      );
      expect(approval).toMatchObject({
        mode: "full-access",
        riskLevel: "critical",
        dataUsed: ["routineId: routine-research-digest-123"],
        confirmationPhrase: `approve ${tool}`
      });
      expect(approval.consequence).not.toMatch(/unregistered/i);
    }
  });
});

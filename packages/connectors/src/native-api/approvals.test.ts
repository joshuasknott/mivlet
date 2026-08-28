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

    const selection = buildToolApproval("openai", "local-browser-action", JSON.stringify({
      action: "select",
      observationId: "observation-1234567890abcdef",
      elementRef: "control-1234567890abcdef-1",
      controlRole: "combobox",
      controlName: "Region",
      value: "Europe"
    }));
    expect(selection.dataUsed).toContain("value: Europe");
    expect(selection.confirmationPhrase).toBe("approve local-browser-action");
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

});

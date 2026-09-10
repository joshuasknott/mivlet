import { describe, expect, it } from "vitest";
import { buildToolApproval } from "./approvals";

describe("buildToolApproval", () => {
  it("matches native canonical JSON for nested input independent of provider key order", () => {
    const first = buildToolApproval("Codex", "github-read", '{"input":{"repository":"owner/repo","path":"README.md"},"capability":"files.read"}');
    const second = buildToolApproval("Codex", "github-read", '{"capability":"files.read","input":{"path":"README.md","repository":"owner/repo"}}');
    expect(first.dataUsed).toEqual(second.dataUsed);
    expect(first.dataUsed).toEqual(['capability: files.read', 'input: {"path":"README.md","repository":"owner/repo"}']);
  });
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


  it("binds every native application control field and treats observation as a read", () => {
    const observation = buildToolApproval("openai", "local-app-observe", "{}");
    expect(observation).toMatchObject({ mode: "read-only", riskLevel: "medium" });
    expect(observation.confirmationPhrase).toBeUndefined();

    const action = buildToolApproval("openai", "local-app-action", JSON.stringify({
      action: "type",
      observationId: "observation-1234567890abcdef",
      elementRef: "control-1234567890abcdef-0",
      text: "Mivlet"
    }));
    expect(action).toMatchObject({
      mode: "full-access",
      riskLevel: "critical",
      confirmationPhrase: "approve local-app-action"
    });
    expect(action.dataUsed).toEqual([
      "action: type",
      "elementRef: control-1234567890abcdef-0",
      "observationId: observation-1234567890abcdef",
      "text: Mivlet"
    ]);


  });

  it("binds foreground selection separately and explains its focus effect", () => {
    const background = buildToolApproval("openai", "local-app-select", '{"windowId":"window-a"}');
    const foreground = buildToolApproval("openai", "local-app-select", '{"windowId":"window-a","deliveryMode":"foreground"}');
    expect(background.consequence).toContain("without bringing it forward");
    expect(foreground.consequence).toContain("may interrupt your work");
    expect(foreground.dataUsed).toEqual(["deliveryMode: foreground", "windowId: window-a"]);
    expect(foreground.id).not.toBe(background.id);
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
      action: "type",
      observationId: "observation-1234567890abcdef",
      elementRef: "control-1234567890abcdef-1",
      value: "quarterly plan"
    }));

    expect(approval.dataUsed).toEqual([
      "action: type",
      "elementRef: control-1234567890abcdef-1",
      "observationId: observation-1234567890abcdef",
      "value: quarterly plan"
    ]);
  });

});

import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@fable/protocol";
import { createDesktopToolExecutor } from "./desktop-tool-runtime";

const approval: ApprovalRequest = {
  id: "acp-copilot-session-tool",
  service: "copilot",
  action: "acp-permission Edit src/app.ts",
  mode: "full-access",
  riskLevel: "high",
  dataUsed: ["kind: edit", "path: src/app.ts"],
  consequence:
    "Allow copilot to run the provider action once. Fable only returns the permission decision.",
  requestedAt: new Date(0).toISOString(),
  decisions: ["once", "modify", "deny"],
  confirmationPhrase: "approve copilot action"
};

describe("desktop ACP permission execution", () => {
  it("waits for Fable's gate but does not dispatch the provider-owned tool to Rust", async () => {
    const executor = createDesktopToolExecutor({
      waitForDecision: async () => "granted"
    });
    await expect(executor(approval, JSON.stringify({ path: "src/app.ts" }))).resolves.toBe(
      "ACP permission granted once."
    );
  });

  it("fails closed when the Fable approval gate denies", async () => {
    const executor = createDesktopToolExecutor({
      waitForDecision: async () => "denied"
    });
    await expect(executor(approval, "{}")).rejects.toThrow(/denied/i);
  });
});

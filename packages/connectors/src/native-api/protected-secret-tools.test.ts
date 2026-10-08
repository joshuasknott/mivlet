import { describe, expect, it } from "vitest";
import { buildToolApproval } from "./approvals";
import { lookupTool, registeredToolSpecs } from "./tools";
import { PROTECTED_SECRET_TOOLS } from "./protected-secret-tools";

describe("protected secret tools", () => {
  it("offers only metadata capture and the closed webhook consumer", () => {
    for (const tool of PROTECTED_SECRET_TOOLS) {
      expect(registeredToolSpecs().find(t => t.name === tool.name)).toBeDefined();
      const schema = JSON.parse(tool.parameters);
      expect(schema.additionalProperties).toBe(false);
      for (const forbidden of ["secret", "password", "value", "credential", "url", "command"]) {
        expect(schema.properties).not.toHaveProperty(forbidden);
      }
    }
    const schema = JSON.parse(lookupTool("request-secret")!.parameters);
    expect(schema.properties.consumer.enum).toEqual(["webhook-signing-key"]);
    expect(schema.properties.purpose.enum).toEqual(["verify-webhook-signature"]);
    expect(lookupTool("request-secret")!.defaultRisk).toBe("high");
    expect(lookupTool("webhook-signing-install")!.defaultMode).toBe("full-access");
  });
  it("binds the complete request and verification body to the approval digest", () => {
    const first = buildToolApproval("codex", "webhook-signing-verify", JSON.stringify({ keyId: "key", targetId: "target", body: "x".repeat(400) + "a", signature: "sha256=" + "0".repeat(64) }));
    const changed = buildToolApproval("codex", "webhook-signing-verify", JSON.stringify({ keyId: "key", targetId: "target", body: "x".repeat(400) + "b", signature: "sha256=" + "0".repeat(64) }));
    const digest = (value: typeof first) => value.dataUsed.find(v => v.startsWith("Arguments SHA-256:"));
    expect(digest(first)).toMatch(/^Arguments SHA-256: [a-f0-9]{64}$/);
    expect(digest(first)).not.toBe(digest(changed));
  });
});

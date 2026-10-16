import { describe, expect, it } from "vitest";
import { buildToolApproval } from "./approvals";
import { registeredToolSpecs } from "./tools";
import { effectForTool, evaluatePermissionPolicy } from "../permission-policy";
describe("checkpoint tool reachability and authority", () => {
  it("exposes complete file-checkpoint tools in the real shared registry", () => {
    const tools = registeredToolSpecs();
    for (const action of ["list", "capture", "preview", "restore", "delete"])
      expect(
        tools.some((t) => t.name === `repository-checkpoint-${action}`),
      ).toBe(true);
  });
  it("binds each restore hash and forbids standing grants", () => {
    const args = {
      repositoryId: "copy",
      checkpointId: "saved",
      expectedTree: "current",
      expectedCheckpointTree: "checkpoint-tree",
      expectedOutput: "output",
      expectedHead: "head",
    };
    const original = buildToolApproval(
      "codex",
      "repository-checkpoint-restore",
      JSON.stringify(args),
    );
    expect(original).toMatchObject({
      riskLevel: "critical",
      mode: "full-access",
      confirmationPhrase: "approve repository-checkpoint-restore",
      decisions: ["once", "modify", "deny"],
    });
    expect(original.consequence).toContain(
      "invalidate prior test verification",
    );
    for (const key of Object.keys(args)) {
      const changed = buildToolApproval(
        "codex",
        "repository-checkpoint-restore",
        JSON.stringify({ ...args, [key]: "different" }),
      );
      expect(changed.dataUsed.at(-1)).not.toBe(original.dataUsed.at(-1));
    }
  });
  it("maps native and provider checkpoint effects without permitting read-only mutation", () => {
    for (const [action, effect] of [
      ["list", "local-read"],
      ["preview", "local-read"],
      ["capture", "local-write"],
      ["restore", "local-write"],
      ["delete", "delete"],
    ] as const) {
      const name = `repository-checkpoint-${action}`;
      expect(effectForTool(name)).toBe(effect);
      const approval = buildToolApproval("Mivlet", name, "{}");
      expect(
        evaluatePermissionPolicy({
          mode: "read-only",
          effect,
          riskLevel: approval.riskLevel,
        }).allowed,
      ).toBe(effect === "local-read");
      if (effect !== "local-read") {
        expect(
          evaluatePermissionPolicy({
            mode: approval.mode,
            effect,
            riskLevel: approval.riskLevel,
          }),
        ).toMatchObject({ allowed: true, approvalRequired: true });
      }
    }
  });
});

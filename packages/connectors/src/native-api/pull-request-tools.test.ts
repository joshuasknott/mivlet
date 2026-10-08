import { describe, expect, it } from "vitest";
import { PULL_REQUEST_TOOLS } from "./pull-request-tools";
import { buildToolApproval } from "./approvals";
describe("PR tool authority", () => {
  it("keeps every PR tool in its exact repository namespace and authority class", () => {
    expect(
      PULL_REQUEST_TOOLS.map(({ name, defaultMode, defaultRisk }) => [
        name,
        defaultMode,
        defaultRisk,
      ]),
    ).toEqual([
      ["repository-pr-read", "read-only", "low"],
      ["repository-pr-local", "full-access", "high"],
      ["repository-pr-action", "full-access", "critical"],
      ["repository-pr-watch", "full-access", "high"],
    ]);
    for (const tool of PULL_REQUEST_TOOLS) {
      const schema = JSON.parse(tool.parameters);
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toContain("repositoryId");
      expect(schema.required).toContain("action");
    }
  });
  it("binds every target and review parameter beyond preview length to an exact digest", () => {
    const input = {
      repositoryId: "repo",
      number: 7,
      action: "review",
      remote: "https://github.com/example/repository.git",
      baseBranch: "main",
      baseSha: "b".repeat(40),
      headBranch: "mivlet/task",
      expectedHead: "a".repeat(40),
      body: "x".repeat(400),
      event: "APPROVE",
    };
    const original = buildToolApproval(
      "codex",
      "repository-pr-action",
      JSON.stringify(input),
    );
    expect(original.riskLevel).toBe("critical");
    expect(original.confirmationPhrase).toBe("approve repository-pr-action");
    for (const [key, value] of Object.entries(input)) {
      const changed = buildToolApproval(
        "codex",
        "repository-pr-action",
        JSON.stringify({
          ...input,
          [key]: typeof value === "number" ? value + 1 : value + "changed",
        }),
      );
      expect(changed.dataUsed.at(-1)).not.toBe(original.dataUsed.at(-1));
    }
  });
  it("offers no merge, force-push, arbitrary endpoint or retry operation", () => {
    const schema = JSON.parse(
      PULL_REQUEST_TOOLS.find((tool) => tool.name === "repository-pr-action")!
        .parameters,
    );
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.action.enum).toEqual([
      "push",
      "edit",
      "review",
      "submit",
      "delete-draft",
      "recover",
    ]);
    expect(schema.properties).not.toHaveProperty("token");
    expect(schema.properties).not.toHaveProperty("url");
  });
});

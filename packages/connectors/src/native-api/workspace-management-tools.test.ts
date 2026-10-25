import { describe, expect, it } from "vitest";
import { effectForTool } from "../permission-policy";
import { buildToolApproval } from "./approvals";
import { createApprovalGate, createToolExecutor } from "./tool-executor";
import { isCollaborationTool, lookupTool, registeredToolSpecs } from "./tools";
import {
  WORKSPACE_MANAGEMENT_TOOLS,
  isWorkspaceManagementTool,
  workspaceManagementToolSpecs,
} from "./workspace-management-tools";

interface JsonSchema {
  type?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  minItems?: number;
  uniqueItems?: boolean;
  required?: string[];
  anyOf?: Array<{ required?: string[] }>;
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
}

function schema(name: string): JsonSchema {
  return JSON.parse(WORKSPACE_MANAGEMENT_TOOLS[name]!.parameters) as JsonSchema;
}

describe("workspace management tool contracts", () => {
  it("keeps inspection read-only and argument-free", () => {
    expect(isWorkspaceManagementTool("workspace-inspect")).toBe(true);
    expect(schema("workspace-inspect")).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(WORKSPACE_MANAGEMENT_TOOLS["workspace-inspect"]).toMatchObject({
      defaultMode: "read-only",
      defaultRisk: "low",
    });
  });

  it("requires bounded inputs for agent lifecycle operations", () => {
    expect(schema("agent-create").required).toEqual(["name", "instructions"]);
    expect(schema("agent-create").properties?.name).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 80,
    });
    expect(schema("agent-update").required).toEqual(["agentId"]);
    expect(schema("agent-update").anyOf).toEqual([
      { required: ["name"] },
      { required: ["instructions"] },
      { required: ["modelAgentId"] },
    ]);
    expect(schema("agent-delete").required).toEqual(["agentId"]);
    expect(WORKSPACE_MANAGEMENT_TOOLS["agent-delete"]).toMatchObject({
      defaultMode: "full-access",
      defaultRisk: "critical",
    });
  });

  it("requires explicit project membership and revision fences", () => {
    expect(schema("project-create").required).toEqual([
      "name",
      "instructions",
      "participantIds",
    ]);
    expect(schema("project-create").properties?.participantIds).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
    });
    expect(schema("project-team-update").required).toEqual([
      "projectId",
      "expectedRevision",
      "participantIds",
      "shareHistory",
    ]);
    expect(schema("project-team-update").properties?.expectedRevision).toMatchObject({
      type: "integer",
      minimum: 1,
    });
  });

  it("is present in the lookup registry, dedicated model specs and policy", () => {
    for (const name of Object.keys(WORKSPACE_MANAGEMENT_TOOLS)) {
      expect(lookupTool(name), name).toBe(WORKSPACE_MANAGEMENT_TOOLS[name]);
      expect(registeredToolSpecs().some((tool) => tool.name === name), name).toBe(false);
      expect(workspaceManagementToolSpecs().some((tool) => tool.name === name), name).toBe(true);
      expect(effectForTool(name), name).not.toBeNull();
    }
    expect(effectForTool("workspace-inspect")).toBe("coordination");
    expect(effectForTool("agent-create")).toBe("app-state-mutation");
    expect(effectForTool("agent-delete")).toBe("delete");
    expect(effectForTool("project-create")).toBe("app-state-mutation");
    expect(effectForTool("project-team-update")).toBe("app-state-mutation");
  });

  it("does not route lifecycle tools through the coordination bypass", () => {
    for (const name of Object.keys(WORKSPACE_MANAGEMENT_TOOLS)) {
      expect(isWorkspaceManagementTool(name)).toBe(true);
      expect(isCollaborationTool(name)).toBe(false);
    }
  });

  it("binds every mutating lifecycle approval to its complete arguments", () => {
    const first = buildToolApproval(
      "codex",
      "agent-update",
      JSON.stringify({ agentId: "agent-a", instructions: "Research carefully." }),
    );
    const changed = buildToolApproval(
      "codex",
      "agent-update",
      JSON.stringify({ agentId: "agent-a", instructions: "Research quickly." }),
    );
    const digest = (approval: typeof first) =>
      approval.dataUsed.find((value) => value.startsWith("Arguments SHA-256: "));
    expect(digest(first)).toMatch(/^Arguments SHA-256: [a-f0-9]{64}$/);
    expect(digest(first)).not.toBe(digest(changed));
    expect(
      buildToolApproval("codex", "workspace-inspect", "{}").dataUsed.some((value) =>
        /^Arguments SHA-256: [a-f0-9]{64}$/.test(value),
      ),
    ).toBe(true);
    expect(
      buildToolApproval("codex", "agent-update", JSON.stringify({ agentId: "agent-a", name: "Scout" })).decisions,
    ).toEqual(["once", "deny"]);
    expect(buildToolApproval("codex", "workspace-inspect", "{}").decisions).toEqual(["once", "deny"]);
    expect(buildToolApproval("codex", "read-file", '{"path":"notes.md"}').decisions).toEqual([
      "once",
      "modify",
      "deny",
    ]);
  });

  it("keeps lifecycle mutations behind the real approval gate and out of Read Only", async () => {
    const approval = buildToolApproval(
      "codex",
      "agent-create",
      JSON.stringify({ name: "Scout", instructions: "Research." }),
    );
    expect(approval).toMatchObject({ mode: "full-access", riskLevel: "high" });
    const gate = createApprovalGate();
    expect(gate.register(approval)).toBe(true);
    gate.resolveGrant(approval.id);
    const executor = createToolExecutor({
      gate,
      permissionMode: "read-only",
      runtime: {
        readFile: async () => null,
        writeFile: async () => 0,
        runShell: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        fetchUrl: async () => null,
      },
    });
    await expect(executor(approval, JSON.stringify({ name: "Scout", instructions: "Research." })))
      .rejects.toThrow(/Read Only|read-only profile forbids agent-create/i);
  });
});

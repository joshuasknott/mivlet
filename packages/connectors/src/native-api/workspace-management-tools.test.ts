import { describe, expect, it } from "vitest";
import { effectForTool } from "../permission-policy";
import { buildToolApproval } from "./approvals";
import { lookupTool, registeredToolSpecs } from "./tools";
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
      maxLength: 120,
    });
    expect(schema("agent-update").required).toEqual(["agentId"]);
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
      maxItems: 32,
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
      minimum: 0,
    });
  });

  it("is present in the supported model-facing registry and policy", () => {
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
    expect(buildToolApproval("codex", "workspace-inspect", "{}").dataUsed).not.toContain(
      expect.stringContaining("Arguments SHA-256:"),
    );
  });
});

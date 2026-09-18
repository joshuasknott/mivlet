import { describe, expect, it } from "vitest";
import {
  COLLABORATION_TOOLS,
  collaborationToolSpecs,
  isCollaborationTool,
} from "./collaboration-tools";

interface JsonSchema {
  type?: string;
  minLength?: number;
  maxLength?: number;
}

interface ObjectSchema {
  type: string;
  properties: Record<string, JsonSchema>;
  required: string[];
  additionalProperties: boolean;
}

function schema(name: string): ObjectSchema {
  return JSON.parse(COLLABORATION_TOOLS[name].parameters) as ObjectSchema;
}

describe("workspace collaboration tool contracts", () => {
  it("advertises bounded workspace agent discovery with no inputs", () => {
    expect(isCollaborationTool("workspace-agents")).toBe(true);
    expect(schema("workspace-agents")).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
    expect(COLLABORATION_TOOLS["workspace-agents"].description).toContain(
      "stable agent IDs",
    );
    expect(COLLABORATION_TOOLS["workspace-agents"].description).toContain(
      "private conversations",
    );
  });

  it("requires a durable assignment id for task scoped messaging", () => {
    expect(isCollaborationTool("teammate-message")).toBe(true);
    const message = schema("teammate-message");
    expect(message.required).toEqual(["assignmentId", "message", "question"]);
    expect(message.additionalProperties).toBe(false);
    expect(message.properties.assignmentId).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 128,
    });
    expect(message.properties.message).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 6000,
    });
    expect(message.properties.question).toMatchObject({ type: "boolean" });
    expect(COLLABORATION_TOOLS["teammate-message"].description).toMatch(
      /does not grant permission/i,
    );
  });

  it("makes discovery and messaging available in ordinary conversations", () => {
    const ordinary = collaborationToolSpecs(false).map((tool) => tool.name);
    expect(ordinary).toEqual(
      expect.arrayContaining([
        "workspace-agents",
        "teammate-assign",
        "teammate-message",
        "team-await-user",
      ]),
    );
    expect(ordinary).not.toContain("project-record");
  });
});

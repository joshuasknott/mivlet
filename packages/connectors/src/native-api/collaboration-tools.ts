import type { BackendTool, NativeToolSpec } from "@fable/protocol";

const field = (maxLength: number) => ({
  type: "string",
  minLength: 1,
  maxLength,
});
function tool(
  name: string,
  description: string,
  properties: Record<string, object>,
): BackendTool {
  return {
    name,
    description,
    defaultMode: "read-only",
    defaultRisk: "low",
    parameters: JSON.stringify({
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    }),
  };
}

/** Registered globally for adapter validation, advertised only in an authorized group execution. */
export const COLLABORATION_TOOLS: Record<string, BackendTool> = {
  "teammate-assign": tool(
    "teammate-assign",
    "Ask a current named participant a specific question or assign useful work. Mivlet queues their own configured model and returns the assignment ID. This is asynchronous: finish your public contribution after dispatch; Mivlet returns their result in a fresh turn. Do not claim their work is complete. Delegation supplies no additional permission or private context. Avoid duplicate, self, or circular handoffs.",
    {
      agentId: field(128),
      prompt: field(6000),
      title: field(120),
      dependencies: {
        type: "array",
        items: field(128),
        maxItems: 4,
        description:
          "Existing peer work IDs that must complete first, otherwise [].",
      },
      focused: {
        type: "boolean",
        description:
          "Create a focused project conversation for this assignment; false for standalone groups.",
      },
    },
  ),
  "project-record": tool(
    "project-record",
    "Record a project fact or decision with provenance. Agent entries are inferences or dated external observations. Only the user can confirm a fact or supersede a confirmed decision. Use the public result for evidence; do not include private chain of thought.",
    {
      text: field(2000),
      factKind: { type: "string", enum: ["fact", "decision"] },
      source: field(1000),
      confidence: {
        type: "string",
        enum: ["inference", "external-observation"],
      },
    },
  ),
  "team-await-user": tool(
    "team-await-user",
    "Pause this exchange after your public response when a decision, missing information, or reconciliation is required. Explain the specific question or blocker; this does not authorize any external action.",
    { reason: field(2000) },
  ),
};

export function isCollaborationTool(name: string): boolean {
  return Object.hasOwn(COLLABORATION_TOOLS, name);
}
export function collaborationToolSpecs(project: boolean): NativeToolSpec[] {
  return Object.values(COLLABORATION_TOOLS)
    .filter((tool) => project || tool.name !== "project-record")
    .map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
}

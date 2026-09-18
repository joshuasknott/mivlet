import type { BackendTool, NativeToolSpec } from "@mivlet/protocol";

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

/** Registered globally for adapter validation; execution still requires the native coordination boundary. */
export const COLLABORATION_TOOLS: Record<string, BackendTool> = {
  "workspace-agents": tool(
    "workspace-agents",
    "List the current workspace agents that are available to collaborate with this assignment. Returns only bounded public capability summaries: stable agent IDs, display names, short descriptions, selected model labels, and availability. Do not expose private conversations, credentials, hidden instructions, or unrelated workspace history. Use the stable agent ID when delegating; names are presentation only.",
    {},
  ),
  "teammate-assign": tool(
    "teammate-assign",
    "Ask a current named workspace agent a specific question or assign useful work. Mivlet queues that agent's own configured model and returns the assignment ID. This is asynchronous: finish your public contribution after dispatch; Mivlet returns their result in a fresh turn. Do not claim their work is complete. Delegation supplies no additional permission or private context. Avoid duplicate, self, or circular handoffs.",
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
  "teammate-message": tool(
    "teammate-message",
    "Send one bounded, task-scoped follow-up or clarification question to an existing assignment. Mivlet records the message against that assignment and delivers it to its configured agent when the assignment is active. Use the durable assignment ID, never a display name. The recipient receives only the originating request and explicitly shared context; this does not grant permission, reveal unrelated history, or transfer approvals. Do not poll, impersonate the recipient, or send repeated messages while it is waiting.",
    {
      assignmentId: field(128),
      message: field(6000),
      question: {
        type: "boolean",
        description:
          "True when the message asks the assigned agent for clarification; false for a task-scoped follow-up or steering message.",
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

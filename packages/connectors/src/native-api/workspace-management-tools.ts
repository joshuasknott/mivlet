import type { BackendTool, NativeToolSpec, WorkspaceManagementTool } from "@mivlet/protocol";

const text = (maxLength: number) => ({
  type: "string",
  minLength: 1,
  maxLength,
});

const agentIds = {
  type: "array",
  minItems: 1,
  maxItems: 8,
  uniqueItems: true,
  items: text(128),
};

function schema(
  properties: Record<string, unknown>,
  required: string[] = [],
  extras: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    ...extras,
    additionalProperties: false,
  });
}

function mutation(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  defaultRisk: BackendTool["defaultRisk"] = "high",
  schemaExtras: Record<string, unknown> = {},
): BackendTool {
  return {
    name,
    description,
    defaultMode: "full-access",
    defaultRisk,
    parameters: schema(properties, required, schemaExtras),
  };
}

/**
 * Mivlet-owned workspace lifecycle tools. These are kept separate from the
 * task-delegation tools because they change durable workspace configuration.
 * The native boundary validates the caller, revisions, membership and model
 * references; modelAgentId can copy configuration only, never credentials or
 * private history.
 */
export const WORKSPACE_MANAGEMENT_TOOLS: Record<string, BackendTool> = {
  "workspace-inspect": {
    name: "workspace-inspect",
    description:
      "Inspect the current workspace agents, projects, teams and safe availability summaries. Returns bounded public profiles and a receipt-safe view only; never expose credentials, private instructions, private conversations or unrelated history. Use stable IDs for subsequent lifecycle calls.",
    defaultMode: "read-only",
    defaultRisk: "low",
    parameters: schema({}, []),
  },
  "agent-create": mutation(
    "agent-create",
    "Create one persistent Mivlet agent profile for this workspace. Provide a clear name and bounded instructions. The new agent uses the caller's current model by default; modelAgentId may copy an existing agent's model and effort settings only. Never copy credentials, private instructions, conversation history or grants.",
    {
      name: text(80),
      instructions: text(8_000),
      modelAgentId: text(128),
    },
    ["name", "instructions"],
  ),
  "agent-update": mutation(
    "agent-update",
    "Update one existing Mivlet agent profile by stable ID. Supply at least one of name, instructions or modelAgentId. Model changes copy only the referenced agent's model and effort settings; credentials, private history, permissions and grants never move through this tool.",
    {
      agentId: text(128),
      name: text(80),
      instructions: text(8_000),
      modelAgentId: text(128),
    },
    ["agentId"],
    "high",
    {
      anyOf: [
        { required: ["name"] },
        { required: ["instructions"] },
        { required: ["modelAgentId"] },
      ],
    },
  ),
  "agent-delete": mutation(
    "agent-delete",
    "Delete one persistent Mivlet agent by stable ID after native checks. Mivlet preserves historical authorship and returns a bounded receipt with the updated safe workspace projection; it does not silently transfer work or grant access. Reassign or stop affected work explicitly.",
    { agentId: text(128) },
    ["agentId"],
    "critical",
  ),
  "project-create": mutation(
    "project-create",
    "Create one Mivlet project with a durable brief and explicit team membership. participantIds must contain existing agent IDs; leadAgentId, when supplied, must be one of them. Project creation shares only the project context selected by the native boundary and never grants provider or computer authority.",
    {
      name: text(80),
      instructions: text(8_000),
      participantIds: agentIds,
      leadAgentId: text(128),
    },
    ["name", "instructions", "participantIds"],
  ),
  "project-team-update": mutation(
    "project-team-update",
    "Replace a project's explicit team using its expected revision. participantIds must be existing agent IDs and leadAgentId, when supplied, must be a participant. shareHistory explicitly declares whether current project history is shared during this membership change; native checks cancel or preserve affected work safely.",
    {
      projectId: text(128),
      expectedRevision: { type: "integer", minimum: 1 },
      participantIds: agentIds,
      leadAgentId: text(128),
      shareHistory: { type: "boolean" },
    },
    ["projectId", "expectedRevision", "participantIds", "shareHistory"],
  ),
};

export function isWorkspaceManagementTool(name: string): name is WorkspaceManagementTool {
  return Object.hasOwn(WORKSPACE_MANAGEMENT_TOOLS, name);
}

export function workspaceManagementToolSpecs(): NativeToolSpec[] {
  return Object.values(WORKSPACE_MANAGEMENT_TOOLS).map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
}

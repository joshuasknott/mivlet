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
      "Inspect agents, projects, teams and safe availability. Return bounded public profiles and receipt-safe data only; never expose credentials, private instructions, private conversations or unrelated history. Use stable IDs.",
    defaultMode: "read-only",
    defaultRisk: "low",
    parameters: schema({}, []),
  },
  "agent-create": mutation(
    "agent-create",
    "Create persistent agent: clear name, bounded instructions. Default caller model; modelAgentId copies only existing model/effort. Never copy credentials, private instructions, conversation history or grants.",
    {
      name: text(80),
      instructions: text(8_000),
      modelAgentId: text(128),
    },
    ["name", "instructions"],
  ),
  "agent-update": mutation(
    "agent-update",
    "Update agent by ID: name, instructions or modelAgentId. Copy model/effort only; never credentials, private history, permissions or grants.",
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
    "Delete agent by ID after native checks. Preserve historical authorship; return bounded receipt/safe projection. Never silently transfer work/access; reassign or stop affected work.",
    { agentId: text(128) },
    ["agentId"],
    "critical",
  ),
  "project-create": mutation(
    "project-create",
    "Create project: durable brief, explicit team. participantIds must be existing IDs; supplied leadAgentId must be a participant. Share only native-selected project context; never grant provider/computer authority.",
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
    "Replace project team at expected revision. participantIds must be existing IDs; supplied leadAgentId must be a participant. shareHistory explicitly controls project-history sharing; native safely cancels/preserves affected work.",
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

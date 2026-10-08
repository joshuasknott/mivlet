import type { BackendTool } from "@mivlet/protocol";

const text = { type: "string" };
const repositoryId = {
  type: "string",
  description: "Exact private-copy id from repository-status.",
};
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  risk: "low" | "high" | "critical",
): BackendTool {
  return {
    name: `repository-checkpoint-${name}`,
    description,
    defaultMode: risk === "low" ? "read-only" : "full-access",
    defaultRisk: risk,
    parameters: JSON.stringify({
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    }),
  };
}
export const CHECKPOINT_TOOLS: Record<string, BackendTool> = {
  "repository-checkpoint-list": tool(
    "list",
    "List private-copy checkpoints with request provenance and SHA-256 trees; separate from chat history.",
    { repositoryId },
    "low",
  ),
  "repository-checkpoint-capture": tool(
    "capture",
    "Save tracked/new code before edits or after checks. Excludes ignored files, credentials and Git metadata. Limit 24 checkpoints/512 MiB; original unchanged.",
    { repositoryId, label: { type: "string", maxLength: 160 } },
    "high",
  ),
  "repository-checkpoint-preview": tool(
    "preview",
    "Preview added/deleted/changed files and currentTreeId/outputTreeId/checkpoint.treeId/head. Review full files if truncated. Preserves ignored files; conflicts fail closed. Read-only.",
    { repositoryId, checkpointId: text },
    "low",
  ),
  "repository-checkpoint-restore": tool(
    "restore",
    "Approved FILE restore in this private copy using fresh preview hashes. Saves current code; invalidates test verification. No original/Git HEAD/chat/external rollback. Refuses Stop/drift; uncertain import needs repository-recover.",
    {
      repositoryId,
      checkpointId: text,
      expectedTree: text,
      expectedCheckpointTree: text,
      expectedOutput: text,
      expectedHead: text,
    },
    "critical",
  ),
  "repository-checkpoint-delete": tool(
    "delete",
    "Approved deletion of one exact checkpoint. Releases storage; preserves current files and repository copy.",
    { repositoryId, checkpointId: text, expectedCheckpointTree: text },
    "critical",
  ),
};

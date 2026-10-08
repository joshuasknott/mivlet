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
    "List immutable checkpoints of the selected private copy, request provenance and SHA-256 trees. Separate from chat history.",
    { repositoryId },
    "low",
  ),
  "repository-checkpoint-capture": tool(
    "capture",
    "Save tracked/new code before risky edits or after verification. Exclude ignored files, credentials and Git metadata. Max 24 checkpoints/512 MiB; original unchanged.",
    { repositoryId, label: { type: "string", maxLength: 160 } },
    "high",
  ),
  "repository-checkpoint-preview": tool(
    "preview",
    "Preview additions/deletions/changes and currentTreeId/outputTreeId/checkpoint.treeId/head. Truncated diff requires full-file review. Preserve ignored files; conflicts fail closed. Does not restore.",
    { repositoryId, checkpointId: text },
    "low",
  ),
  "repository-checkpoint-restore": tool(
    "restore",
    "Explicitly approved FILE restore in the selected private copy, binding fresh preview hashes. Checkpoint current code; invalidate test receipts. No original/Git HEAD/chat/external rollback. Stop/drift refuse; uncertain import needs repository-recover.",
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
    "Approved deletion of one exact checkpoint to release storage. Preserve current files and repository copy.",
    { repositoryId, checkpointId: text, expectedCheckpointTree: text },
    "critical",
  ),
};

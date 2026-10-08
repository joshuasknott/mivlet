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
    "List immutable file checkpoints of this agent's selected private repository copy. Includes native request provenance and exact SHA-256 trees. Separate from conversation history.",
    { repositoryId },
    "low",
  ),
  "repository-checkpoint-capture": tool(
    "capture",
    "Save a meaningful code state before risky edits or after a verified milestone. Captures tracked and relevant new files; excludes ignored files, credentials and Git metadata. Bounded to 24 checkpoints/512 MiB. Original checkout unchanged.",
    { repositoryId, label: { type: "string", maxLength: 160 } },
    "high",
  ),
  "repository-checkpoint-preview": tool(
    "preview",
    "Review exact restore additions/deletions/changes and currentTreeId, outputTreeId, checkpoint.treeId, head. Read full files if diff is truncated. Ignored files preserved; conflicts fail closed. Never restores by itself.",
    { repositoryId, checkpointId: text },
    "low",
  ),
  "repository-checkpoint-restore": tool(
    "restore",
    "After explicit user approval restore reviewed FILES only in this exact private copy. Bind all hashes from fresh preview. Saves a before-restore checkpoint, invalidates test receipts; no source checkout, Git HEAD, conversation or external-effect rollback. Stop/drift/uncertainty refuses stale restore; use repository-recover after uncertain import.",
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
    "Explicitly delete one exact file checkpoint to release bounded storage. Current repository files remain unchanged. Never removes a repository copy.",
    { repositoryId, checkpointId: text, expectedCheckpointTree: text },
    "critical",
  ),
};

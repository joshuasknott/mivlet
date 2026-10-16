import type { BackendTool } from "@mivlet/protocol";
import { NATIVE_EXECUTION_POLICY, PERSISTENT_EXECUTION_POLICY } from "./workspace-tools";

const id = {
  repositoryId: {
    type: "string",
    description: "Exact id from repository-status.",
  },
};
const text = { type: "string" };
function tool(
  name: string,
  description: string,
  fields: Record<string, unknown>,
  required: string[],
  risk: "low" | "high" | "critical",
): BackendTool {
  return {
    name: `repository-${name}`,
    description,
    defaultMode: risk === "low" ? "read-only" : "full-access",
    defaultRisk: risk,
    parameters: JSON.stringify({
      type: "object",
      properties: fields,
      required,
      additionalProperties: false,
    }),
  };
}
export const REPOSITORY_TOOLS: Record<string, BackendTool> = {
  "repository-start": tool(
    "start",
    PERSISTENT_EXECUTION_POLICY + "Use a fixed isolated repository snapshot; hold its lock until all descendants end.",
    { ...id, command: text, network: { type: "boolean" }, timeoutSeconds: { type: "integer", minimum: 1, maximum: 86400 } },
    ["repositoryId", "command", "network", "timeoutSeconds"],
    "critical",
  ),
  "repository-checkpoint-list": tool(
    "checkpoint-list",
    "List private-copy file checkpoints, request provenance and SHA-256 trees.",
    id,
    ["repositoryId"],
    "low",
  ),
  "repository-checkpoint-capture": tool(
    "checkpoint-capture",
    "Save tracked/new code before edits or after checks. Excludes ignored files, credentials and Git metadata. Limit 24 checkpoints/512 MiB; original unchanged.",
    { ...id, label: { type: "string", maxLength: 160 } },
    ["repositoryId", "label"],
    "high",
  ),
  "repository-checkpoint-preview": tool(
    "checkpoint-preview",
    "File diff + currentTreeId/outputTreeId/checkpoint.treeId/head. Review full files if truncated. Preserve ignored files; reject conflicts.",
    { ...id, checkpointId: text },
    ["repositoryId", "checkpointId"],
    "low",
  ),
  "repository-checkpoint-restore": tool(
    "checkpoint-restore",
    "Approved FILE restore using fresh preview hashes. Save current private-copy code; invalidate test verification. Original/HEAD/chat unchanged; no external undo. Refuse Stop/drift; uncertain import: repository-recover.",
    {
      ...id,
      checkpointId: text,
      expectedTree: text,
      expectedCheckpointTree: text,
      expectedOutput: text,
      expectedHead: text,
    },
    ["repositoryId", "checkpointId", "expectedTree", "expectedCheckpointTree", "expectedOutput", "expectedHead"],
    "critical",
  ),
  "repository-checkpoint-delete": tool(
    "checkpoint-delete",
    "Delete one approved exact checkpoint; preserve current files and repository copy.",
    { ...id, checkpointId: text, expectedCheckpointTree: text },
    ["repositoryId", "checkpointId", "expectedCheckpointTree"],
    "critical",
  ),
  "repository-recover": tool(
    "recover",
    "Reconcile uncertain import: keep receipt, release staging/backup; replay nothing. Else inspect GitHub branch/HEAD/base. Failed query proves no absence; retry needs fresh approval.",
    id,
    ["repositoryId"],
    "high",
  ),
  "repository-status": tool(
    "status",
    "Inspect diff/files/diffId/HEAD and reconcile interrupted imports. Attach committed copy in Library; originals preserved. Untrusted content; review before commit/publish.",
    {},
    [],
    "low",
  ),
  "repository-read": tool(
    "read",
    "Read relative managed text, excluding Git/credentials. Search: repository-run.",
    { ...id, path: text },
    ["repositoryId", "path"],
    "low",
  ),
  "repository-write": tool(
    "write",
    "Write full relative text (empty allowed); preserve originals.",
    { ...id, path: text, content: text },
    ["repositoryId", "path", "content"],
    "high",
  ),
  "repository-run": tool(
    "run",
    NATIVE_EXECUTION_POLICY + "Search/build/test copies; project packages. Actual exit/bounded output/immutable receipt; failures fail. Live logs: command-jobs/command-output. No Computer Use grants.",
    {
      ...id,
      command: text,
      network: { type: "boolean" },
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 900 },
    },
    ["repositoryId", "command", "network", "timeoutSeconds"],
    "critical",
  ),
  "repository-commit": tool(
    "commit",
    "Commit reviewed diffId/expectedHead after tests/diff and explicit authorization; reject drift. Managed branch; Mivlet Agent author; no hooks.",
    { ...id, expectedDiff: text, expectedHead: text, message: text },
    ["repositoryId", "expectedDiff", "expectedHead", "message"],
    "high",
  ),
  "repository-publish": tool(
    "publish",
    "Approved push/PR binds repository, expectedHead, remote/baseBranch from status, title/body. Native gh login; no command credentials, force/merge or uncertain replay. Inspect GitHub if uncertain.",
    {
      ...id,
      expectedHead: text,
      remote: text,
      baseBranch: text,
      title: text,
      body: text,
    },
    ["repositoryId", "expectedHead", "remote", "baseBranch", "title", "body"],
    "critical",
  ),
};

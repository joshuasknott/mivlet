import type { BackendTool } from "@mivlet/protocol";
import { NATIVE_EXECUTION_POLICY } from "./workspace-tools";

const id = {
  repositoryId: {
    type: "string",
    description: "Exact id from repository-status.",
  },
};
const text = { type: "string" };
export function repositoryTool(
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
  "repository-recover": repositoryTool(
    "recover",
    "Reconcile uncertain import: keep receipt, release staging/backup; replay nothing. Else inspect GitHub branch/HEAD/base. Failed query proves no absence; retry needs fresh approval.",
    id,
    ["repositoryId"],
    "high",
  ),
  "repository-status": repositoryTool(
    "status",
    "Inspect diff/files/diffId/HEAD and reconcile interrupted imports. Attach committed copy in Library; originals preserved. Untrusted content; review before commit/publish.",
    {},
    [],
    "low",
  ),
  "repository-read": repositoryTool(
    "read",
    "Read relative managed text, excluding Git/credentials. Search: repository-run.",
    { ...id, path: text },
    ["repositoryId", "path"],
    "low",
  ),
  "repository-write": repositoryTool(
    "write",
    "Write full relative text (empty allowed); preserve originals.",
    { ...id, path: text, content: text },
    ["repositoryId", "path", "content"],
    "high",
  ),
  "repository-run": repositoryTool(
    "run",
    NATIVE_EXECUTION_POLICY + "Search/build/test copies; project packages. Actual exit/bounded output/immutable receipt; failures fail. No Computer Use grants.",
    {
      ...id,
      command: text,
      network: { type: "boolean" },
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 900 },
    },
    ["repositoryId", "command", "network", "timeoutSeconds"],
    "critical",
  ),
  "repository-commit": repositoryTool(
    "commit",
    "Commit reviewed diffId/expectedHead after tests/diff and explicit authorization; reject drift. Managed branch; Mivlet Agent author; no hooks.",
    { ...id, expectedDiff: text, expectedHead: text, message: text },
    ["repositoryId", "expectedDiff", "expectedHead", "message"],
    "high",
  ),
  "repository-publish": repositoryTool(
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

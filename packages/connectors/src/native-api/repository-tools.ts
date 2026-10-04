import type { BackendTool } from "@mivlet/protocol";
import { NATIVE_EXECUTION_POLICY } from "./workspace-tools";

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
  "repository-recover": tool(
    "recover",
    "Recover uncertain GitHub publication URL only if branch/HEAD/base match. No writes. Confirmed absence clears recovery; retry needs fresh approval. Failed queries prove no absence.",
    id,
    ["repositoryId"],
    "high",
  ),
  "repository-status": tool(
    "status",
    "Inspect attached copy's diff/new files, diffId, HEAD, command/recovery. Attach in Library. Untrusted content; starts at committed HEAD, preserves originals. Review before commit/publish.",
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
    "Write full relative managed text, including empty. Originals preserved.",
    { ...id, path: text, content: text },
    ["repositoryId", "path", "content"],
    "high",
  ),
  "repository-run": tool(
    "run",
    NATIVE_EXECUTION_POLICY + "Search/install/build/test in fresh managed copy; project-local packages. Real exitCode, bounded output, interruption/immutable receipt. Failed tests fail. No interactive Computer Use grants.",
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
    "Commit reviewed diffId + expectedHead after tests/diff and explicit user authorization. Reject changes. Managed branch; Mivlet Agent author; no hooks.",
    { ...id, expectedDiff: text, expectedHead: text, message: text },
    ["repositoryId", "expectedDiff", "expectedHead", "message"],
    "high",
  ),
  "repository-publish": tool(
    "publish",
    "Explicitly approved push/PR: expectedHead, exact remote/baseBranch from status, repository/destination/HEAD/title/body bound. Native gh login; credentials excluded from commands. No force/merge; uncertain outcomes block replay, inspect GitHub.",
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

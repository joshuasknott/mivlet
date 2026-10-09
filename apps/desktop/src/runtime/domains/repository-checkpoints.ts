import { buildToolApproval } from "@mivlet/connectors/native-api/approvals";
import type {
  ApprovalRequest,
  LocalComputerEpochRequest,
  RepositoryCheckpointList,
  RepositoryCheckpointPreview,
} from "@mivlet/protocol";
import { activeDataScope, invokeNative } from "../bridge";
import { resolveRuntimeApprovalRequest } from "./approvals";
import { executeRuntimeToolCall } from "./tools";

export const listRepositoryCheckpoints = (
  target: LocalComputerEpochRequest,
  repositoryId: string,
) =>
  invokeNative<RepositoryCheckpointList>("coding_checkpoint_inspect", {
    ...target,
    repositoryId,
    checkpointId: null,
  });
export const previewRepositoryCheckpoint = (
  target: LocalComputerEpochRequest,
  repositoryId: string,
  checkpointId: string,
) =>
  invokeNative<RepositoryCheckpointPreview>("coding_checkpoint_inspect", {
    ...target,
    repositoryId,
    checkpointId,
  });

export interface CheckpointAction {
  target: LocalComputerEpochRequest;
  tool: string;
  arguments: Record<string, unknown>;
  approval: ApprovalRequest;
  scope: string;
}
export function prepareCheckpointAction(
  target: LocalComputerEpochRequest,
  action: "capture" | "restore" | "delete",
  args: Record<string, unknown>,
): CheckpointAction {
  const tool = `repository-checkpoint-${action}`;
  const approval = buildToolApproval("Mivlet", tool, JSON.stringify(args));
  return {
    target: { ...target },
    tool,
    arguments: args,
    scope: JSON.stringify(activeDataScope()),
    approval: {
      ...approval,
      id: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      dataUsed: [
        ...approval.dataUsed,
        `Computer workspace: ${target.workspaceId}`,
        `Computer agent: ${target.agentId}`,
        `Computer generation: ${target.expectedGeneration}`,
      ],
    },
  };
}
/** Called only by the user's explicit confirmation, with their typed text.
 * Native resolution persists the one-use permit; execution consumes it. */
export async function executeCheckpointAction(
  action: CheckpointAction,
  confirmationText: string,
) {
  const checkScope = () => {
    if (JSON.stringify(activeDataScope()) !== action.scope)
      throw new Error(
        "The account or workspace changed. Review this action again.",
      );
  };
  checkScope();
  const approval = {
    request: action.approval,
    decision: "once" as const,
    decidedAt: new Date().toISOString(),
    confirmationText,
  };
  const resolved = await resolveRuntimeApprovalRequest(approval);
  if (!resolved?.persisted || resolved.auditEntry.decision !== "once")
    throw new Error("Checkpoint action was not approved.");
  checkScope();
  const result = await executeRuntimeToolCall({
    tool: action.tool,
    arguments: action.arguments,
    approval,
    workspaceId: action.target.workspaceId,
    agentId: action.target.agentId,
    computerGeneration: action.target.expectedGeneration,
  });
  if (!result?.ok)
    throw new Error(
      result?.output || "Open the desktop app to use checkpoints.",
    );
  checkScope();
  return result;
}

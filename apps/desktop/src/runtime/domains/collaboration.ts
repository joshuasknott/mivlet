import type {
  CollaborationCommand,
  CollaborationSnapshot,
} from "@mivlet/protocol";
import { getRuntimeAdapter } from "../adapters/select";
import { toRuntimeError } from "../errors";

async function invoke(
  command: string,
  request: object,
): Promise<CollaborationSnapshot> {
  const adapter = getRuntimeAdapter();
  if (adapter.kind === "preview")
    throw new Error(
      "Conversations and teamwork require the installed desktop app.",
    );
  try {
    return await adapter.invoke<CollaborationSnapshot>(command, { request });
  } catch (error) {
    const runtimeError = toRuntimeError(error);
    if (
      command === "collaboration_command" &&
      /unknown field [`'](?:recipientIds|recipients)[`']/.test(
        runtimeError.message,
      )
    ) {
      throw new Error(
        "The desktop runtime is out of date. Restart Mivlet after updating it to use workspace agent mentions. Your draft has been kept.",
      );
    }
    throw runtimeError;
  }
}

export const loadCollaboration = (workspaceId: string) =>
  invoke("collaboration_load", { workspaceId });
export const commandCollaboration = (
  workspaceId: string,
  command: CollaborationCommand,
) => invoke("collaboration_command", { workspaceId, command });

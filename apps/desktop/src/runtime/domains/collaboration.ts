import type {
  CollaborationCommand,
  CollaborationSnapshot,
} from "@fable/protocol";
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
    throw toRuntimeError(error);
  }
}

export const loadCollaboration = (workspaceId: string) =>
  invoke("collaboration_load", { workspaceId });
export const commandCollaboration = (
  workspaceId: string,
  command: CollaborationCommand,
) => invoke("collaboration_command", { workspaceId, command });

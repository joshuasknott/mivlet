import type {
  ConversationUiCommand,
  ConversationUiOwner,
} from "@mivlet/protocol";
import { getRuntimeAdapter } from "../adapters/select";
import { toRuntimeError } from "../errors";

export async function conversationUi<T>(
  owner: ConversationUiOwner,
  command: ConversationUiCommand,
): Promise<T> {
  const adapter = getRuntimeAdapter();
  if (adapter.kind === "preview")
    throw new Error(
      "Saving interactive answers and inspecting account context require the installed desktop app.",
    );
  try {
    return await adapter.invoke<T>("collaboration_ui", {
      request: { ...owner, ...command },
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

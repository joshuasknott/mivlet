import type {
  ConversationUiCommand,
  ConversationUiOwner,
} from "@mivlet/protocol";
import { invokeRequiredNative } from "../required-native";

export async function conversationUi<T>(
  owner: ConversationUiOwner,
  command: ConversationUiCommand,
): Promise<T> {
  return invokeRequiredNative<T>(
    "collaboration_ui",
    { request: { ...owner, ...command } },
    "Saving interactive answers and inspecting account context require the installed desktop app.",
  );
}

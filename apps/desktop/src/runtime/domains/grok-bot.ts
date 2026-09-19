import type { RemoteBotConnection, RemoteBotTransport } from "@mivlet/protocol";
import { hasTauriRuntime, invoke } from "../bridge";

function desktop() {
  if (!hasTauriRuntime())
    throw new Error(
      "Connect the bridge in the Windows desktop app. Browser preview cannot access Grok Bot.",
    );
}

export async function grokBotSetupScope() {
  desktop();
  return invoke<string>("grok_bot_setup_scope");
}

export const grokBotTransport: RemoteBotTransport = {
  async connect() {
    desktop();
    return invoke<RemoteBotConnection>("grok_bot_connect");
  },
  async read(sessionId, botId, cursor) {
    desktop();
    return invoke("grok_bot_call", {
      sessionId,
      botId,
      operation: "read",
      cursor,
    });
  },
  async send(sessionId, botId, message, requestId) {
    desktop();
    return invoke("grok_bot_call", {
      sessionId,
      botId,
      operation: "send",
      message,
      requestId,
    });
  },
  async disconnect(sessionId) {
    desktop();
    await invoke("grok_bot_disconnect", { sessionId });
  },
};

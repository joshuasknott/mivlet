import type { EmbeddedRuntimeEvent } from "@fable/connectors";
import type { AgentTurnRequest } from "@fable/protocol";
import { hasTauriRuntime, invoke, listen } from "../bridge";

export async function startRuntimeEmbeddedMcp(requestId: string) {
  if (!hasTauriRuntime())
    throw new Error("MCP discovery requires the desktop app.");
  await invoke("start_embedded_mcp", { requestId });
}

export async function sendRuntimeEmbeddedMcp(
  requestId: string,
  frame: unknown,
) {
  await invoke("send_embedded_mcp", { requestId, frame });
}

export async function closeRuntimeEmbeddedMcp(requestId: string) {
  if (hasTauriRuntime()) await invoke("close_embedded_mcp", { requestId });
}

export async function listenRuntimeEmbeddedMcp(
  requestId: string,
  receive: (frame: unknown) => void,
) {
  if (!hasTauriRuntime()) return null;
  return listen<unknown>(`fable://embedded-mcp/${requestId}`, (event) =>
    receive(event.payload),
  );
}

export async function startRuntimeEmbeddedAgent(input: {
  requestId: string;
  providerId: string;
  request: import("@fable/protocol").AgentTurnRequest;
  contextPrefix?: string;
  computer?: { workspaceId: string; agentId: string };
  maxTurns: number;
  maxToolCalls: number;
  contextWindow: number;
}) {
  if (!hasTauriRuntime())
    throw new Error("The native agent host is unavailable.");
  await invoke("start_embedded_agent", { input });
}

export async function replyRuntimeEmbeddedAgent(
  requestId: string,
  callId: string,
  ok: boolean,
  output: string,
) {
  await invoke("reply_embedded_agent", { requestId, callId, ok, output });
}

export async function cancelRuntimeEmbeddedAgent(requestId: string) {
  if (hasTauriRuntime()) await invoke("cancel_embedded_agent", { requestId });
}

export async function listenRuntimeEmbeddedAgent(
  requestId: string,
  receive: (event: EmbeddedRuntimeEvent) => void,
) {
  if (!hasTauriRuntime()) return null;
  return listen<EmbeddedRuntimeEvent>(
    `fable://embedded-agent/${requestId}`,
    (event) => receive(event.payload),
  );
}

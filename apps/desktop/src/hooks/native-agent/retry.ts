import type {
  AgentTurnRequest,
  BackendModel,
  ExecutionAttempt,
} from "@mivlet/protocol";
import type { AgentBackend } from "@mivlet/connectors";
import {
  buildInterruptedAttemptCheckpoint,
  INTERRUPTED_CHECKPOINT_INSTRUCTION,
} from "../../lib/agent-run";
import { CONVERSATION_STYLE_INSTRUCTIONS } from "../../lib/conversation-presentation";

export function describeRetryBlock(
  attemptToRetry: ExecutionAttempt,
  input: {
    threadId: string | undefined;
    models: BackendModel[];
    backend: AgentBackend | null;
  },
): string | null {
  const userExchange = attemptToRetry.exchanges
    ?.filter((exchange) => exchange.role === "user")
    .at(-1);
  if (!attemptToRetry.recoverable || !userExchange?.content.trim()) {
    return "This interrupted run does not contain a safe user prompt to retry.";
  }
  if (userExchange.images?.length) {
    return "Reattach the original images before retrying; image pixels are not stored.";
  }
  if (userExchange.attachments?.length) {
    return "Reattach the original files and send a new message; retry does not reuse attachment access.";
  }
  if (attemptToRetry.threadId !== input.threadId) {
    return "Open this run's conversation before retrying it.";
  }
  const model = input.models.find(
    (candidate) => candidate.id === attemptToRetry.model,
  );
  if (!model?.available || model.capabilities?.streaming === false) {
    return "This run cannot be retried because its model is unavailable or cannot stream.";
  }
  if (input.backend?.providerId !== attemptToRetry.providerId) {
    return "Select the attempt's original provider before retrying it.";
  }
  return null;
}

export function buildRetryTurnRequest(
  attemptToRetry: ExecutionAttempt,
  tools: AgentTurnRequest["tools"],
  instructions: string = CONVERSATION_STYLE_INSTRUCTIONS,
): AgentTurnRequest | null {
  const userExchange = attemptToRetry.exchanges
    ?.filter((exchange) => exchange.role === "user")
    .at(-1);
  if (!userExchange?.content.trim()) return null;
  return {
    model: attemptToRetry.model,
    messages: [
      {
        role: "system",
        content: `${instructions.trim()}\n\n${INTERRUPTED_CHECKPOINT_INSTRUCTION}`,
      },
      {
        role: "assistant",
        content: buildInterruptedAttemptCheckpoint(attemptToRetry),
      },
      { role: "user", content: userExchange.content },
    ],
    tools,
    maxTokens: 2_048,
  };
}


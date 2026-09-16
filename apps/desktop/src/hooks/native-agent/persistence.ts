import type {
  AgentTurnRequest,
  ExecutionAttempt,
  ExecutionContextReceipt,
  ExecutionExchange,
  ProviderRouteExecutionBinding,
} from "@mivlet/protocol";
import type { NativeAgentRunControl } from "./types";

export function buildQueuedExchanges(
  request: AgentTurnRequest,
  control?: NativeAgentRunControl,
): ExecutionExchange[] {
  const initialExchanges: ExecutionExchange[] = request.messages
    .filter(
      (
        message,
      ): message is typeof message & {
        role: "user" | "assistant" | "tool";
      } => message.role !== "system",
    )
    .map((message) => ({
      role: message.role,
      content: message.content,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      ...(message.images?.length
        ? {
            images: message.images.map(
              ({ id, name, mediaType, sizeBytes, width, height }) => ({
                id,
                name,
                mediaType,
                sizeBytes,
                width,
                height,
              }),
            ),
          }
        : {}),
    }));
  const durableAttachments = control?.attachments?.filter(
    (attachment) => attachment.availability !== "image-input",
  );
  const lastUserExchange = initialExchanges
    .filter((exchange) => exchange.role === "user")
    .at(-1);
  if (lastUserExchange && durableAttachments?.length) {
    lastUserExchange.attachments = [...durableAttachments];
  }
  return initialExchanges;
}

export function buildQueuedAttempt(input: {
  attemptId: string;
  providerId: string;
  model: string;
  threadId: string | undefined;
  exchanges: ExecutionExchange[];
  parentAttemptId?: string;
  contextReceipt: ExecutionContextReceipt;
  providerRoute?: ProviderRouteExecutionBinding;
  createdAt: string;
}): ExecutionAttempt {
  return {
    id: input.attemptId,
    providerId: input.providerId,
    model: input.model,
    status: "queued",
    transcript: "",
    threadId: input.threadId,
    exchanges: input.exchanges,
    parentAttemptId: input.parentAttemptId,
    contextReceipt: input.contextReceipt,
    ...(input.providerRoute ? { providerRoute: input.providerRoute } : {}),
    turn: 0,
    pendingApprovalIds: [],
    recoverable: true,
    retryCount: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function prependRecoverableAttempt(
  attempts: ExecutionAttempt[],
  attempt: ExecutionAttempt,
): ExecutionAttempt[] {
  return [
    attempt,
    ...attempts.filter((run) => run.id !== attempt.id),
  ];
}

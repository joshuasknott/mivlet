import type { Dispatch, SetStateAction } from "react";
import { isRoutineConnectorRead } from "@mivlet/connectors/native-api/tool-executor";
import { isCollaborationTool } from "@mivlet/connectors/native-api/tools";
import type {
  BackendAgentEvent,
  ExecutionAttempt,
  ExecutionExchange,
} from "@mivlet/protocol";
import { describeBackendError } from "../../lib/backend-errors";
import type { AttemptPersistence } from "../../lib/attempt-persistence";
import type { DurableRunWriter } from "../../lib/conversation-runtime";
import {
  appendResponseText,
  resolveResponseTool,
  toolActivity,
  toolConnectorId,
} from "../../lib/conversation-presentation";
import type { NativeAgentState } from "./types";
import { prependRecoverableAttempt } from "./persistence";

export interface NativeAgentEventSession {
  persisted: ExecutionAttempt;
  persistence: AttemptPersistence;
  durableWriter: DurableRunWriter | null;
  attemptId: string;
  setState: Dispatch<SetStateAction<NativeAgentState>>;
  onToolCall?: () =>
    | ((event: Extract<BackendAgentEvent, { type: "tool-call" }>) => void)
    | undefined;
  onTextDelta?: (text: string) => void;
  pendingApprovalByCall: Map<string, string>;
  toolNameByCall: Map<string, string>;
  lastPersistedTranscriptLength: number;
  lastPersistedAt: number;
}

export async function consumeNativeAgentEvents(
  eventStream: AsyncIterable<BackendAgentEvent>,
  session: NativeAgentEventSession,
): Promise<{ terminalized: boolean }> {
  let terminalized = false;
  for await (const event of eventStream) {
    if (session.persistence.stopped) {
      session.persisted = session.persistence.current ?? session.persisted;
      terminalized = true;
      break;
    }
    if (event.type === "reasoning-summary") {
      applyReasoningSummary(event, session);
    } else if (event.type === "text-delta") {
      await applyTextDelta(event, session);
    } else if (event.type === "usage") {
      applyUsage(event, session);
    } else if (event.type === "provider-tool") {
      await applyProviderTool(event, session);
    } else if (event.type === "tool-call") {
      await applyToolCall(event, session);
    } else if (event.type === "tool-result") {
      await applyToolResult(event, session);
    } else if (event.type === "error") {
      await applyError(event, session);
      terminalized = true;
    } else if (event.type === "done" || event.type === "cancelled") {
      await applyTerminal(event, session);
      terminalized = true;
    }
    // Publish every accepted mutation synchronously. Stop reads this
    // snapshot; disk checkpoint cadence must never define visible state.
    session.persistence.current = session.persisted;
    const terminalOrBoundary =
      event.type !== "text-delta" ||
      session.persisted.transcript.length -
        session.lastPersistedTranscriptLength >=
        512 ||
      Date.now() - session.lastPersistedAt >= 1_000;
    if (terminalOrBoundary) {
      session.persistence.current = session.persisted;
      await session.persistence.save(session.persisted);
      session.lastPersistedTranscriptLength =
        session.persisted.transcript.length;
      session.lastPersistedAt = Date.now();
    }
    if (terminalized) break;
  }
  if (!terminalized && session.persisted) {
    await applyProviderEof(session);
    terminalized = true;
  }
  return { terminalized };
}

function applyReasoningSummary(
  event: Extract<BackendAgentEvent, { type: "reasoning-summary" }>,
  session: NativeAgentEventSession,
) {
  const key = `${event.itemId}:${event.summaryIndex}`;
  const summaries: Record<string, string> = {
    ...session.persisted.reasoningSummaries,
  };
  summaries[key] = ((summaries[key] ?? "") + event.text).slice(-16000);
  for (const staleKey of Object.keys(summaries).slice(0, -32))
    delete summaries[staleKey];
  session.persisted = { ...session.persisted, reasoningSummaries: summaries };
  session.setState((current) => {
    return { ...current, reasoningSummaries: summaries };
  });
}

async function applyTextDelta(
  event: Extract<BackendAgentEvent, { type: "text-delta" }>,
  session: NativeAgentEventSession,
) {
  session.setState((current) => ({
    ...current,
    transcript: current.transcript + event.text,
    responseParts: appendResponseText(
      current.responseParts ?? [],
      event.text,
    ),
    activity: "",
  }));
  const exchanges: ExecutionExchange[] = [
    ...(session.persisted.exchanges ?? []),
  ];
  const finalExchange = exchanges.at(-1);
  if (finalExchange?.role === "assistant" && !finalExchange.toolCallId) {
    exchanges[exchanges.length - 1] = {
      ...finalExchange,
      content: finalExchange.content + event.text,
    };
  } else {
    exchanges.push({ role: "assistant", content: event.text });
  }
  session.persisted = {
    ...session.persisted,
    transcript: session.persisted.transcript + event.text,
    exchanges,
    updatedAt: new Date().toISOString(),
  };
  session.persistence.current = session.persisted;
  if (session.durableWriter)
    await session.persistence.checkpointAssistant(session.persisted.transcript);
  if (!session.persistence.stopped) session.onTextDelta?.(event.text);
}

function applyUsage(
  event: Extract<BackendAgentEvent, { type: "usage" }>,
  session: NativeAgentEventSession,
) {
  const usage = {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    costUsd: event.costUsd,
    costEstimated: event.costEstimated,
    costUnknown: event.costUnknown,
  };
  session.setState((current) => ({
    ...current,
    usage,
    usageReceipts: {
      ...current.usageReceipts,
      [session.attemptId]: usage,
    },
  }));
  session.persisted = {
    ...session.persisted,
    usage,
    updatedAt: new Date().toISOString(),
  };
}

async function applyProviderTool(
  event: Extract<BackendAgentEvent, { type: "provider-tool" }>,
  session: NativeAgentEventSession,
) {
  session.toolNameByCall.set(event.callId, event.tool);
  if (event.status === "running") {
    session.persisted = {
      ...session.persisted,
      status: "streaming",
      updatedAt: new Date().toISOString(),
    };
    session.persistence.current = session.persisted;
    session.setState((current) => ({
      ...current,
      activity: toolActivity(event.tool, "running"),
      responseParts: [
        ...(current.responseParts ?? []),
        {
          id: event.callId,
          kind: "tool",
          tool: event.tool,
          content: "",
          state: "running",
        },
      ],
    }));
    if (session.durableWriter) {
      await session.persistence.record({
        kind: "tool-call",
        content: event.arguments,
        callId: event.callId,
        toolName: event.tool,
      });
    }
    return;
  }
  const ok = event.status === "succeeded";
  const output = event.output ?? "";
  session.persisted = {
    ...session.persisted,
    status: "streaming",
    turn: session.persisted.turn + 1,
    exchanges: [
      ...(session.persisted.exchanges ?? []),
      {
        role: "tool",
        content: output,
        toolCallId: event.callId,
        toolName: event.tool,
        ok,
      },
    ],
    updatedAt: new Date().toISOString(),
  };
  session.persistence.current = session.persisted;
  session.setState((current) => ({
    ...current,
    activity: "",
    responseParts: resolveResponseTool(
      current.responseParts ?? [],
      event.callId,
      output,
      ok,
    ),
  }));
  if (session.durableWriter) {
    await session.persistence.record({
      kind: "tool-result",
      content: output,
      callId: event.callId,
      toolName: event.tool,
      ok,
    });
  }
  session.toolNameByCall.delete(event.callId);
}

async function applyToolCall(
  event: Extract<BackendAgentEvent, { type: "tool-call" }>,
  session: NativeAgentEventSession,
) {
  const needsApproval =
    !isCollaborationTool(event.tool) &&
    !isRoutineConnectorRead(event.approval) &&
    !["connector-call", "connector-action"].includes(
      event.approval.action.split(/\s+/)[0],
    );
  session.onToolCall?.()?.(event);
  if (needsApproval)
    session.pendingApprovalByCall.set(event.callId, event.approval.id);
  session.toolNameByCall.set(event.callId, event.tool);
  session.persisted = {
    ...session.persisted,
    status: needsApproval ? "awaiting-approval" : "streaming",
    pendingApprovalIds: [
      ...session.persisted.pendingApprovalIds,
      ...(needsApproval ? [event.approval.id] : []),
    ],
    updatedAt: new Date().toISOString(),
  };
  session.persistence.current = session.persisted;
  session.setState((current) => ({
    ...current,
    status: needsApproval ? "awaiting-approval" : "streaming",
    activity: toolActivity(event.tool, "running"),
    responseParts: [
      ...(current.responseParts ?? []),
      {
        id: event.callId,
        kind: "tool",
        tool: event.tool,
        connectorId: toolConnectorId(event.tool, event.arguments),
        content: "",
        state: "running",
      },
    ],
  }));
  if (session.durableWriter) {
    await session.persistence.record({
      kind: "tool-call",
      content: `Tool requested: ${event.tool}`,
      callId: event.callId,
      toolName: event.tool,
    });
    // Historical evidence only: a recovered request must never become
    // a new permit or standing grant after restart.
    if (needsApproval)
      await session.persistence.record({
        kind: "approval-request",
        content: `Approval requested for ${event.tool}.`,
        approvalRequestId: event.approval.id,
      });
  }
}

async function applyToolResult(
  event: Extract<BackendAgentEvent, { type: "tool-result" }>,
  session: NativeAgentEventSession,
) {
  const completedApprovalId = session.pendingApprovalByCall.get(event.callId);
  const completedToolName = session.toolNameByCall.get(event.callId);
  session.pendingApprovalByCall.delete(event.callId);
  session.persisted = {
    ...session.persisted,
    status: "streaming",
    turn: session.persisted.turn + 1,
    pendingApprovalIds: session.persisted.pendingApprovalIds.filter(
      (id) => id !== completedApprovalId,
    ),
    exchanges: [
      ...(session.persisted.exchanges ?? []),
      {
        role: "tool",
        content: event.output,
        toolCallId: event.callId,
        toolName: completedToolName,
        ok: event.ok,
      },
    ],
    updatedAt: new Date().toISOString(),
  };
  session.persistence.current = session.persisted;
  session.setState((current) => ({
    ...current,
    status: "streaming",
    activity: "",
    responseParts: resolveResponseTool(
      current.responseParts ?? [],
      event.callId,
      event.output,
      event.ok,
    ),
  }));
  if (session.durableWriter)
    await session.persistence.record({
      kind: "tool-result",
      content: event.output,
      callId: event.callId,
      toolName: completedToolName ?? "unknown-tool",
      ok: event.ok,
    });
  session.toolNameByCall.delete(event.callId);
}

async function applyError(
  event: Extract<BackendAgentEvent, { type: "error" }>,
  session: NativeAgentEventSession,
) {
  const described = describeBackendError(
    event.message,
    event.code,
    event.retryable,
  );
  session.setState((current) => ({
    ...current,
    lastError: described.message,
    endedAt: new Date().toISOString(),
  }));
  session.persisted = {
    ...session.persisted,
    error: described.message,
    updatedAt: new Date().toISOString(),
  };
  const terminalRun: ExecutionAttempt = {
    ...session.persisted,
    status: "failed",
    recoverable: true,
    pendingApprovalIds: [],
    updatedAt: new Date().toISOString(),
  };
  session.persisted = terminalRun;
  session.persistence.current = terminalRun;
  if (session.durableWriter)
    await session.persistence.record({
      kind: "error",
      content: described.message,
      code: event.code ?? "provider-error",
      retryable: event.retryable ?? true,
    });
  session.setState((current) => ({
    ...current,
    running: false,
    status: "failed",
    recoverableAttempts: prependRecoverableAttempt(
      current.recoverableAttempts,
      terminalRun,
    ),
  }));
}

async function applyTerminal(
  event: Extract<BackendAgentEvent, { type: "done" | "cancelled" }>,
  session: NativeAgentEventSession,
) {
  const failed: boolean =
    event.type === "done" &&
    (event.finishReason === "error" || Boolean(session.persisted.error));
  const terminalStatus: ExecutionAttempt["status"] =
    event.type === "cancelled"
      ? "cancelled"
      : failed
        ? "failed"
        : "completed";
  const terminalRun: ExecutionAttempt = {
    ...session.persisted,
    status: terminalStatus,
    recoverable: terminalStatus === "failed",
    pendingApprovalIds: [],
    updatedAt: new Date().toISOString(),
  };
  session.persisted = terminalRun;
  session.persistence.current = terminalRun;
  if (session.durableWriter) {
    await session.persistence.checkpointAssistant(
      terminalRun.transcript,
      true,
    );
    if (terminalStatus === "cancelled")
      await session.persistence.record({
        kind: "interruption",
        content: "The response was stopped.",
        reason: "user-stop",
      });
  }
  session.setState((current) => ({
    ...current,
    running: false,
    status: terminalStatus,
    endedAt: terminalRun.updatedAt,
    progressReceipts: {
      ...current.progressReceipts,
      [session.attemptId]: {
        summaries: terminalRun.reasoningSummaries ?? {},
        startedAt: terminalRun.createdAt,
        endedAt: terminalRun.updatedAt,
      },
    },
    recoverableAttempts:
      terminalStatus === "failed"
        ? prependRecoverableAttempt(current.recoverableAttempts, terminalRun)
        : current.recoverableAttempts,
  }));
}

async function applyProviderEof(session: NativeAgentEventSession) {
  const terminalRun: ExecutionAttempt = {
    ...session.persisted,
    status: "failed",
    recoverable: true,
    pendingApprovalIds: [],
    error: "The provider ended without a completion event.",
    updatedAt: new Date().toISOString(),
  };
  session.persisted = terminalRun;
  session.persistence.current = terminalRun;
  if (session.durableWriter)
    await session.persistence.record({
      kind: "error",
      content: terminalRun.error!,
      code: "provider-eof",
      retryable: true,
    });
  await session.persistence.save(terminalRun);
  session.setState((current) => ({
    ...current,
    running: false,
    status: "failed",
    lastError: terminalRun.error!,
    recoverableAttempts: prependRecoverableAttempt(
      current.recoverableAttempts,
      terminalRun,
    ),
  }));
}

export async function failNativeAgentRun(
  session: NativeAgentEventSession,
  error: unknown,
  cancelled: boolean,
): Promise<ExecutionAttempt> {
  const thrown = error as { code?: string; retryable?: boolean };
  const rawMessage =
    error instanceof Error ? error.message : "Agent run failed.";
  const described = describeBackendError(
    rawMessage,
    thrown.code,
    thrown.retryable,
  );
  const message = described.message;
  const terminalRun: ExecutionAttempt = {
    ...session.persisted,
    status: cancelled ? "cancelled" : "failed",
    recoverable: !cancelled,
    error: message,
    updatedAt: new Date().toISOString(),
  };
  session.persisted = terminalRun;
  session.persistence.current = terminalRun;
  if (session.durableWriter) {
    await session.persistence.record(
      cancelled
        ? {
            kind: "interruption",
            content: "The response was stopped.",
            reason: "user-stop",
          }
        : {
            kind: "error",
            content: message,
            code: thrown.code ?? "transport-error",
            retryable: Boolean(thrown.retryable),
          },
    );
  }
  session.setState((current) => ({
    ...current,
    running: false,
    lastError: message,
    status: terminalRun.status,
    endedAt: terminalRun.updatedAt,
    recoverableAttempts: cancelled
      ? current.recoverableAttempts
      : prependRecoverableAttempt(current.recoverableAttempts, terminalRun),
  }));
  try {
    await session.persistence.save(terminalRun);
  } catch {
    /* preserve the original terminal failure */
  }
  return terminalRun;
}

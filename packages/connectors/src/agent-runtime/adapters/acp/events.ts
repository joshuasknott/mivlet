/**
 * Normalize ACP v1 `session/update` notifications into Fable's universal
 * event stream and shape ACP permission requests for Fable's approval queue.
 *
 * ACP agents execute their own tools. Fable therefore never sends a synthetic
 * tool result or re-executes the action. Instead, a `session/request_permission`
 * request becomes an approval-only tool call; after the user decides, the
 * session replies with an ACP `allow_once`/`reject_once` option.
 */

import type {
  ApprovalRequest,
  ApprovalRiskLevel,
  BackendAgentEvent,
  PermissionMode
} from "@fable/protocol";
import type { AcpNotification } from "./protocol";

export const ACP_PERMISSION_TOOL = "acp-permission";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function finiteNumber(...values: unknown[]): number {
  const value = values.find(
    (candidate): candidate is number =>
      typeof candidate === "number" && Number.isFinite(candidate)
  );
  return value === undefined ? 0 : Math.max(0, Math.trunc(value));
}

function boundedString(value: unknown, limit = 16_384): string {
  if (typeof value === "string") return value.slice(0, limit);
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value).slice(0, limit);
  } catch {
    return "";
  }
}

function extractContentText(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  const content = object(value);
  if (!content) return null;
  if (content.type === "text" && typeof content.text === "string") {
    return content.text.length > 0 ? content.text : null;
  }
  return null;
}

/** Map an ACP prompt result's stop reason into Fable's closed vocabulary. */
export function finishReasonForAcpStopReason(
  stopReason: unknown
): Extract<BackendAgentEvent, { type: "done" }>["finishReason"] {
  if (stopReason === "max_tokens" || stopReason === "max_output_tokens") {
    return "length";
  }
  if (stopReason === "refusal" || stopReason === "error") return "error";
  return "stop";
}

/**
 * Normalize a standard ACP v1 `session/update` notification. Unknown update
 * variants are ignored for forward compatibility.
 */
export function normalizeAcpNotification(
  _providerId: string,
  frame: AcpNotification
): BackendAgentEvent | null {
  if (frame.method !== "session/update") return null;
  const params = object(frame.params);
  const update = object(params?.update);
  if (!update || typeof update.sessionUpdate !== "string") return null;

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = extractContentText(update.content);
      return text === null ? null : { type: "text-delta", text };
    }

    case "usage_update": {
      const cost = object(update.cost);
      const currency =
        typeof cost?.currency === "string" ? cost.currency.toUpperCase() : null;
      const exactUsd =
        currency === "USD" && typeof cost?.amount === "number"
          ? cost.amount
          : typeof update.costUsd === "number"
            ? update.costUsd
            : null;
      return {
        type: "usage",
        inputTokens: finiteNumber(
          update.inputTokens,
          update.input_tokens,
          update.used
        ),
        outputTokens: finiteNumber(update.outputTokens, update.output_tokens),
        costUsd: exactUsd ?? 0,
        costEstimated: exactUsd === null ? true : undefined,
        costUnknown: exactUsd === null ? true : undefined
      };
    }

    case "tool_call_update": {
      const callId =
        typeof update.toolCallId === "string" ? update.toolCallId : null;
      if (!callId) return null;
      if (update.status !== "completed" && update.status !== "failed") {
        return null;
      }
      return {
        type: "tool-result",
        callId,
        ok: update.status === "completed",
        output: boundedString(update.rawOutput ?? update.content)
      };
    }

    default:
      return null;
  }
}

export interface AcpPermissionToolCall {
  callId: string;
  arguments: string;
  approval: ApprovalRequest;
}

function permissionLevel(kind: unknown): {
  mode: PermissionMode;
  riskLevel: ApprovalRiskLevel;
} {
  switch (kind) {
    case "read":
    case "search":
    case "think":
      return { mode: "read-only", riskLevel: "low" };
    case "fetch":
      return { mode: "read-only", riskLevel: "medium" };
    case "edit":
    case "move":
      return { mode: "full-access", riskLevel: "high" };
    case "delete":
    case "execute":
    case "switch_mode":
    case "other":
    default:
      return { mode: "full-access", riskLevel: "critical" };
  }
}

function safeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function previewInput(rawInput: unknown): string[] {
  const input = object(rawInput);
  if (!input) {
    const preview = boundedString(rawInput, 240);
    return preview ? [`input: ${preview}`] : [];
  }
  return Object.entries(input)
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${boundedString(value, 180)}`);
}

/**
 * Shape an ACP ToolCall from `session/request_permission` into a one-time
 * Fable approval. The reserved tool name tells the desktop executor to await
 * the existing approval gate without executing a second copy of the action.
 */
export function buildAcpPermissionToolCall(
  providerId: string,
  sessionId: string,
  requestId: string | number,
  toolCallValue: unknown
): AcpPermissionToolCall | null {
  const toolCall = object(toolCallValue);
  if (!toolCall || typeof toolCall.toolCallId !== "string") return null;

  const rawCallId = toolCall.toolCallId;
  if (
    rawCallId.length === 0 ||
    rawCallId.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(rawCallId)
  ) {
    return null;
  }

  const title =
    typeof toolCall.title === "string" && toolCall.title.trim().length > 0
      ? toolCall.title.trim().slice(0, 160)
      : "provider tool action";
  const kind = typeof toolCall.kind === "string" ? toolCall.kind : "other";
  const { mode, riskLevel } = permissionLevel(kind);
  const dataUsed = [`kind: ${kind}`, `action: ${title}`, ...previewInput(toolCall.rawInput)].slice(
    0,
    6
  );
  const idSuffix =
    safeId(`${sessionId}-${String(requestId)}-${rawCallId}`) || "request";
  const action = `${ACP_PERMISSION_TOOL} ${title}`.slice(0, 160);
  const argumentsJson = JSON.stringify({
    toolCallId: rawCallId,
    title,
    kind,
    rawInput: toolCall.rawInput ?? null
  });

  return {
    callId: rawCallId,
    arguments: argumentsJson,
    approval: {
      id: `acp-${safeId(providerId) || "provider"}-${idSuffix}`.slice(0, 120),
      service: providerId,
      action,
      mode,
      riskLevel,
      dataUsed,
      consequence: `Allow ${providerId} to run “${title}” once. The provider executes the action; Fable only returns the permission decision.`,
      requestedAt: new Date().toISOString(),
      decisions: ["once", "modify", "deny"],
      confirmationPhrase:
        mode === "full-access" && (riskLevel === "high" || riskLevel === "critical")
          ? `approve ${providerId} action`
          : undefined
    }
  };
}

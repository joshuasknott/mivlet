/**
 * Normalize ACP (Agent Client Protocol) notifications into Fable's universal
 * {@link BackendAgentEvent} stream.
 *
 * This is the provider-neutral mapping layer: the CLI's JSON-RPC notifications
 * become the same events the native-API loop emits, so `useNativeAgent` and the
 * shell's event handling stay byte-for-byte unchanged. The tool-call approval
 * is built with the **same** `buildToolApproval` the native path uses, so ACP
 * tool calls route through Fable's approval queue identically.
 *
 * Forward-compatible: an unknown notification method yields `null` so a new CLI
 * method can never break the run — the session loop simply ignores it. A
 * malformed notification (missing required fields) also yields `null`.
 */

import type { BackendAgentEvent } from "@fable/protocol";
import { buildToolApproval } from "../../../native-api/approvals";
import { normalizeBackendErrorEvent } from "../../utils/errors";
import type { AcpNotification } from "./protocol";

/** A best-effort extraction of assistant text from a message's params. */
function extractText(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const obj = params as Record<string, unknown>;

  // Simple form: { content: "..." }
  if (typeof obj.content === "string" && obj.content.length > 0) {
    return obj.content;
  }

  // Structured parts form: { parts: [{ type: "text", text }, ...] }
  if (Array.isArray(obj.parts)) {
    const joined = obj.parts
      .filter((part): part is { type: string; text: string } => {
        if (!part || typeof part !== "object") return false;
        const p = part as Record<string, unknown>;
        return p.type === "text" && typeof p.text === "string";
      })
      .map((part) => part.text)
      .join("");
    return joined.length > 0 ? joined : null;
  }

  return null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/**
 * Map a single notification to a {@link BackendAgentEvent}, or null when the
 * notification is unknown, irrelevant, or malformed.
 *
 * @param providerId The ACP provider id (cursor/grok) — used for the approval.
 * @param frame The notification to normalize.
 */
export function normalizeAcpNotification(
  providerId: string,
  frame: AcpNotification
): BackendAgentEvent | null {
  const params = frame.params;
  switch (frame.method) {
    case "session/message": {
      const text = extractText(params);
      return text === null ? null : { type: "text-delta", text };
    }

    case "tool/call": {
      if (!params || typeof params !== "object") return null;
      const obj = params as Record<string, unknown>;
      const callId = typeof obj.callId === "string" ? obj.callId : null;
      const tool = typeof obj.tool === "string" ? obj.tool : null;
      if (!callId || !tool) return null;
      const args = typeof obj.arguments === "string" ? obj.arguments : "";
      // Reuse the native-API approval builder so ACP tool calls are
      // byte-compatible (same decisions, consequence wording, fail-closed
      // behavior for unregistered tools).
      const approval = buildToolApproval(providerId, tool, args);
      return { type: "tool-call", callId, tool, arguments: args, approval };
    }

    case "tool/result": {
      if (!params || typeof params !== "object") return null;
      const obj = params as Record<string, unknown>;
      const callId = typeof obj.callId === "string" ? obj.callId : null;
      if (!callId) return null;
      const ok = obj.ok !== false; // default to success unless explicitly false
      const output = typeof obj.output === "string" ? obj.output : "";
      return { type: "tool-result", callId, ok, output };
    }

    case "session/usage": {
      if (!params || typeof params !== "object") return null;
      const obj = params as Record<string, unknown>;
      // CLIs (subscription-backed) rarely report cost; when absent, label the
      // cost as estimated (mirrors the native loop's cost-estimate convention).
      const hasCost = typeof obj.costUsd === "number" && Number.isFinite(obj.costUsd);
      return {
        type: "usage",
        inputTokens: asNumber(obj.inputTokens),
        outputTokens: asNumber(obj.outputTokens),
        costUsd: hasCost ? (obj.costUsd as number) : 0,
        costEstimated: hasCost ? undefined : true
      };
    }

    case "session/done": {
      const stopReason =
        params && typeof params === "object"
          ? (params as Record<string, unknown>).stopReason
          : undefined;
      const finishReason =
        stopReason === "length"
          ? "length"
          : stopReason === "tool-calls"
            ? "tool-calls"
            : "stop";
      return { type: "done", finishReason };
    }

    case "session/error": {
      const message =
        params && typeof params === "object"
          ? (params as Record<string, unknown>).message
          : undefined;
      return normalizeBackendErrorEvent({
        type: "error",
        message: typeof message === "string" && message.length > 0 ? message : "ACP session error."
      });
    }

    default:
      // Unknown notification method: ignore (forward-compatible, never raise).
      return null;
  }
}

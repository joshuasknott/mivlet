/**
 * ACP session lifecycle: drive one prompt turn over an {@link AcpTransport} and
 * yield Fable's universal {@link BackendAgentEvent} stream.
 *
 * This is the provider-neutral ACP orchestration. It speaks JSON-RPC over the
 * injected transport (never spawns a process), orchestrates:
 *   initialize → session/new → session/prompt → (streamed notifications) →
 *   session/close,
 * and normalizes the CLI's streamed events. Tool calls route through Fable's
 * shared approval queue: each `tool/call` is yielded as a `tool-call` event
 * carrying a pre-shaped `ApprovalRequest`, and only after the shell's
 * `execute()` runs is the result sent back to the CLI as a `tool/result` frame.
 *
 * The same tool-safety bounds the native-API loop applies are enforced here:
 * max tool calls per run, max tool output characters, argument size, callId
 * shape validation, and replayed/reused callId rejection. Unknown tools are
 * fail-closed via `buildToolApproval`.
 *
 * SECRET INVARIANT: this module holds no key, no token. Auth is CLI-owned; the
 * transport owns the process + auth broker on the Rust side.
 */

import type {
  AgentRunRequest,
  BackendAgentEvent
} from "@fable/protocol";
import type { AgentRunOptions } from "../../contract";
import {
  MAX_TOOL_ARGUMENT_CHARACTERS,
  MAX_TOOL_CALLS_PER_RUN,
  MAX_TOOL_OUTPUT_CHARACTERS
} from "../../../native-api/agent-loop";
import type { AcpRequest } from "./protocol";
import type { AcpTransport } from "./transport";
import { normalizeAcpNotification } from "./events";

/** The ACP protocol version Fable advertises during initialize. */
const ACP_PROTOCOL_VERSION = "2025-06-01";

/** Valid callId characters (mirrors the native loop's callId contract). */
const CALL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_CALL_ID_CHARACTERS = 160;

/** Truncate tool output before it re-enters model context (safety bound). */
function boundedToolOutput(output: string, limit: number): string {
  return output.length > limit ? `${output.slice(0, limit)}…` : output;
}

/** Options the ACP session honors (a subset of the contract's AgentRunOptions). */
export interface AcpSessionOptions {
  /** Executes an approved tool; the session sends the result back to the CLI. */
  execute: AgentRunOptions["execute"];
  /** Cooperative cancellation hook, checked between streamed events. */
  shouldCancel?: () => boolean;
  /** Max tool calls across the whole run (default: the native loop's cap). */
  maxToolCalls?: number;
  /** Max characters returned to model context by one tool. */
  maxToolOutputCharacters?: number;
  /** Max turns (tool rounds) before the session stops. */
  maxTurns?: number;
}

/**
 * Run one ACP prompt turn, yielding {@link BackendAgentEvent}s in order.
 *
 * Sends the protocol handshake + session lifecycle over the transport, then
 * consumes the streamed notification frames, normalizing each into the universal
 * event surface. Tool calls are routed through `execute` and their results sent
 * back. The turn ends on `session/done`, `session/error`, cancellation, or a
 * safety cap; `session/close` + `close()` always run in the finally block.
 */
export async function* runAcpSession(
  transport: AcpTransport,
  providerId: string,
  request: AgentRunRequest,
  options: AcpSessionOptions
): AsyncIterable<BackendAgentEvent> {
  const maxToolCalls = options.maxToolCalls ?? MAX_TOOL_CALLS_PER_RUN;
  const maxToolOutputCharacters =
    options.maxToolOutputCharacters ?? MAX_TOOL_OUTPUT_CHARACTERS;
  const maxTurns = options.maxTurns ?? 8;
  const seenCallIds = new Set<string>();
  let toolCallCount = 0;
  let turn = 0;
  let cancelled = false;
  let errored: string | null = null;

  try {
    // 1. initialize — negotiate protocol version + the CLI's capabilities.
    const initReply = await transport.request(
      acpRequest("initialize", { protocolVersion: ACP_PROTOCOL_VERSION, client: "fable" })
    );
    if (!initReply.ok) {
      yield { type: "error", message: initReply.error.message };
      return;
    }

    // 2. session/new — open a session bound to the requested model.
    const newReply = await transport.request(
      acpRequest("session/new", { model: request.model })
    );
    if (!newReply.ok) {
      yield { type: "error", message: newReply.error.message };
      return;
    }

    // 3. session/prompt — submit the user turn. The CLI replies when the prompt
    //    is accepted, then streams notifications until the turn completes.
    const userMessages = request.messages.filter((m) => m.role === "user");
    const promptReply = await transport.request(
      acpRequest("session/prompt", {
        model: request.model,
        messages: userMessages,
        tools: request.tools,
        maxTokens: request.maxTokens
      })
    );
    if (!promptReply.ok) {
      yield { type: "error", message: promptReply.error.message };
      return;
    }

    // 4. Consume the streamed notification frames.
    for await (const notification of transport.frames()) {
      if (options.shouldCancel?.() === true) {
        cancelled = true;
        break;
      }

      const event = normalizeAcpNotification(providerId, notification);
      if (!event) continue;

      if (event.type === "tool-call") {
        // Validate the callId before routing through the approval queue.
        const callId = event.callId;
        if (
          callId.length === 0 ||
          callId.length > MAX_CALL_ID_CHARACTERS ||
          !CALL_ID_PATTERN.test(callId)
        ) {
          errored = `ACP tool call has a malformed call id.`;
          yield { type: "error", message: errored };
          break;
        }
        if (seenCallIds.has(callId)) {
          errored = `ACP tool call id ${callId} was replayed; refusing.`;
          yield { type: "error", message: errored };
          break;
        }
        if (event.arguments.length > MAX_TOOL_ARGUMENT_CHARACTERS) {
          errored = `ACP tool call ${callId} arguments exceed the supported size.`;
          yield { type: "error", message: errored };
          break;
        }
        if (toolCallCount >= maxToolCalls) {
          errored = `ACP run exceeded its tool-call cap (${maxToolCalls}).`;
          yield { type: "error", message: errored };
          break;
        }
        if (turn >= maxTurns) {
          errored = `ACP run exceeded its turn cap (${maxTurns}).`;
          yield { type: "error", message: errored };
          break;
        }
        seenCallIds.add(callId);
        toolCallCount += 1;
        turn += 1;

        // Yield the tool-call so the shell routes it through the approval queue.
        yield event;

        // Execute the approved tool and send the result back to the CLI.
        let ok = true;
        let output = "";
        try {
          output = boundedToolOutput(
            await options.execute(event.approval, event.arguments),
            maxToolOutputCharacters
          );
        } catch (error) {
          ok = false;
          output = error instanceof Error ? error.message : "Tool execution failed.";
        }
        const toolResultEvent: BackendAgentEvent = {
          type: "tool-result",
          callId,
          ok,
          output
        };
        yield toolResultEvent;
        await transport.send({
          jsonrpc: "2.0",
          method: "tool/result",
          params: { callId, ok, output }
        });
        continue;
      }

      if (event.type === "error") {
        errored = event.message;
        yield event;
        break;
      }
      if (event.type === "done") {
        yield event;
        return;
      }

      // text-delta, usage: forward as-is.
      yield event;
    }

    if (cancelled) {
      yield { type: "cancelled" };
    } else if (errored) {
      // The error event was already yielded; nothing terminal to add.
      return;
    } else {
      // The stream ended without an explicit done/error (CLI closed stdout).
      yield { type: "done", finishReason: "stop" };
    }
  } finally {
    // 5. Always close the session + transport, even on error/cancel.
    await transport.send(acpNotification("session/close", {})).catch(() => {
      /* best-effort: the CLI may already be gone */
    });
    await transport.close().catch(() => {
      /* best-effort shutdown */
    });
  }
}

/** Build a JSON-RPC request with a generated id. */
function acpRequest(method: string, params: unknown): AcpRequest {
  return {
    jsonrpc: "2.0",
    id: `fable-${method}-${Math.random().toString(36).slice(2, 10)}`,
    method,
    params
  };
}

/** Build a JSON-RPC notification (no id). */
function acpNotification(method: string, params: unknown) {
  return { jsonrpc: "2.0" as const, method, params };
}

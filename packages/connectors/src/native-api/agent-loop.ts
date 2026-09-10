/**
 * The Mivlet-owned agent loop for native-API providers.
 *
 * Pure over an injectable HttpTransport + ToolExecutor. One turn = stream a
 * completion; if it finishes with `tool-calls`, the shell must approve + execute
 * each tool (via the executor) and the loop continues with the results appended;
 * otherwise it finishes.
 *
 * Model tool calls NEVER auto-execute — the tool-call event carries an
 * ApprovalRequest that the shell routes through the existing approval queue; the
 * executor only runs once that approval is granted (and refuses otherwise).
 *
 * Cancellation is cooperative: `shouldCancel` is checked between events. Real
 * in-flight cancellation of the HTTP request happens at the Rust boundary.
 */

import type {
  ApprovalRequest,
  BackendAgentEvent,
  NativeCompletionRequest,
  NativeMessage,
  PermissionMode
} from "@fable/protocol";
import { catalogueCapabilities } from "./model-catalogue";
import { streamAnthropicEvents } from "./anthropic";
import { streamGeminiEvents } from "./gemini";
import { streamOpenAiEvents } from "./openai-compat";
import {
  CONNECTED_SOURCE_BRIEF_GUIDANCE,
  WEB_SOURCE_BRIEF_GUIDANCE,
  lookupTool,
  registeredToolSpecs
} from "./tools";
import type { HttpTransport } from "./transport";
import { classifyBackendError } from "../agent-runtime/utils/errors";
import { effectForTool, evaluatePermissionPolicy } from "../permission-policy";

type FinishReason = "stop" | "tool-calls" | "length" | "error";

/** Executes an approved tool. Production wires this to Mivlet runtime functions;
 *  tests inject a fake. Throws if the approval was not granted (fail-closed). */
export type ToolExecutor = (approval: ApprovalRequest, args: string) => Promise<string>;

export interface RunAgentLoopOptions {
  execute: ToolExecutor;
  /**
   * Explicit model-level tool support resolved by the owning backend. When it
   * is absent, the loop falls back to the curated model catalogue. Unknown is
   * intentionally not treated as support.
   */
  modelSupportsTools?: boolean;
  /** Cooperative cancellation hook, checked between events. */
  shouldCancel?: () => boolean;
  /** Max turns before the loop stops (safety). */
  maxTurns?: number;
  /** Optional system-context prefix (pinned memory/knowledge by trust level). */
  contextPrefix?: string;
  /**
   * The composer's permission level, used to gate tool execution before the
   * approval queue. `read-only` suppresses `full-access` (write/shell) tool
   * calls — they surface as a denied tool-result rather than executing. Defaults
   * to `full-access` (the executor/approval flow still gates everything).
   *
   * NOTE: this only decides whether a tool call reaches the executor. The
   * executor itself (actually running read-file/write-file/run-shell) is wired
   * by the tool-execution goal; until then the executor refuses (fail-closed).
   */
  permissionMode?: PermissionMode;
  /** Stable run id used to bind approvals and reject cross-run/replayed calls. */
  runId?: string;
  /** Maximum accepted tool calls across the whole run. */
  maxToolCalls?: number;
  /** Maximum characters returned to model context by one tool. */
  maxToolOutputCharacters?: number;
  /** Whether this provider/model should receive tool schemas at all. */
  toolsEnabled?: boolean;
}

export const MAX_TOOL_ARGUMENT_CHARACTERS = 64_000;
export const MAX_TOOL_OUTPUT_CHARACTERS = 64_000;
export const MAX_TOOL_CALLS_PER_RUN = 32;

/** Wrap the executor so the permission mode gates tool dispatch before approval. */
function permissionGatedExecutor(
  execute: ToolExecutor,
  permissionMode: PermissionMode
): ToolExecutor {
  return async (approval, args) => {
    const toolName = approval.action.split(/\s+/)[0];
    const effect = effectForTool(toolName);
    const decision = effect
      ? evaluatePermissionPolicy({
          mode: permissionMode,
          effect,
          riskLevel: approval.riskLevel
        })
      : null;
    if (!decision?.allowed) {
      throw new Error(
        `Permission denied: ${permissionMode} profile forbids ${approval.action}. ${decision?.reason ?? "Unknown tool effect."}`
      );
    }
    return execute(approval, args);
  };
}

function streamFor(
  providerId: string
): (transport: HttpTransport, request: NativeCompletionRequest) => AsyncIterable<BackendAgentEvent> {
  if (providerId === "anthropic") return streamAnthropicEvents;
  if (providerId === "gemini") return streamGeminiEvents;
  return streamOpenAiEvents; // Every supported OpenAI-compatible provider shares this path.
}

function transportErrorEvent(error: unknown): Extract<BackendAgentEvent, { type: "error" }> {
  const candidate = error as { message?: unknown; code?: unknown; retryable?: unknown };
  const message = typeof candidate?.message === "string" ? candidate.message : "Provider stream failed.";
  const classified = classifyBackendError(message);
  return {
    type: "error",
    message,
    code: typeof candidate?.code === "string" ? candidate.code : classified.code,
    retryable: typeof candidate?.retryable === "boolean" ? candidate.retryable : classified.retryable
  };
}

interface PendingToolCall {
  callId: string;
  tool: string;
  arguments: string;
  approval: ApprovalRequest;
}

/** Run the agent loop, yielding every BackendAgentEvent in order. */
export async function* runAgentLoop(
  transport: HttpTransport,
  request: NativeCompletionRequest,
  options: RunAgentLoopOptions
): AsyncIterable<BackendAgentEvent> {
  // The native loop owns Mivlet's tool catalogue, but it must only advertise it
  // when tool support is known. A newly discovered model with no capability
  // metadata stays runnable for plain chat without being assumed tool-capable.
  const modelSupportsTools =
    options.modelSupportsTools ??
    catalogueCapabilities(request.providerId, request.model)?.tools;
  const tools = options.toolsEnabled === false || modelSupportsTools !== true ? []
    : request.tools.length ? request.tools.filter((tool) => lookupTool(tool.name))
      : registeredToolSpecs().filter(tool => !tool.name.startsWith("local-desktop-"));
  const maxTurns = options.maxTurns ?? 8;
  const permissionMode = options.permissionMode ?? "full-access";
  const execute = permissionGatedExecutor(options.execute, permissionMode);
  const systemPrefix = [
    options.contextPrefix?.trim(),
    tools.some((tool) => tool.name === "connection-read")
      ? `Mivlet tool-use policy: ${CONNECTED_SOURCE_BRIEF_GUIDANCE}`
      : undefined,
    tools.some((tool) => tool.name === "web-fetch")
      ? `Mivlet web-source policy: ${WEB_SOURCE_BRIEF_GUIDANCE}`
      : undefined
  ].filter((part): part is string => Boolean(part)).join("\n\n");
  const messages: NativeMessage[] = systemPrefix
    ? [{ role: "system", content: systemPrefix }, ...request.messages]
    : [...request.messages];
  const seenCallIds = new Set<string>();
  let toolCallCount = 0;

  const bindApproval = (callId: string, approval: ApprovalRequest): ApprovalRequest => ({
    ...approval,
    id: transport.toolApprovalId?.(callId) ?? `native-${options.runId ?? "run"}-${callId}`
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .slice(0, 160),
    service: request.providerId,
    requestedAt: new Date().toISOString()
  });

  const boundedToolOutput = (output: string): string => {
    const limit = options.maxToolOutputCharacters ?? MAX_TOOL_OUTPUT_CHARACTERS;
    return output.length <= limit
      ? output
      : `${output.slice(0, limit)}\n[Tool output truncated by Mivlet at ${limit} characters.]`;
  };

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const turnRequest: NativeCompletionRequest = { ...request, messages, tools };
    const stream = streamFor(request.providerId)(transport, turnRequest);

    let finishReason: FinishReason = "stop";
    const pendingToolCalls: PendingToolCall[] = [];
    let rejectedToolCall = false;

    try {
      for await (const event of stream) {
        if (options.shouldCancel?.()) {
          yield { type: "cancelled" };
          return;
        }
        if (event.type === "done") {
          finishReason = event.finishReason;
          continue; // hold the done event; decide whether to continue after the turn
        }
        if (event.type === "error") {
          finishReason = "error";
        }
        if (event.type === "tool-call") {
          const invalidReason =
            !lookupTool(event.tool)
              ? `Rejected unknown tool "${event.tool}".`
              : !tools.some(tool => tool.name === event.tool)
                ? `Rejected tool "${event.tool}" because it was not advertised for this route.`
                : event.tool.startsWith("local-desktop-") && !transport.toolApprovalId?.(event.callId)
                  ? "Rejected desktop tool because its native provider call binding is missing."
              : !event.callId ||
                  event.callId.length > 160 ||
                  !/^[a-zA-Z0-9_-]+$/.test(event.callId)
                ? "Rejected malformed tool call id."
                : seenCallIds.has(event.callId)
                  ? `Rejected replayed tool call "${event.callId}".`
                  : event.arguments.length > MAX_TOOL_ARGUMENT_CHARACTERS
                    ? "Rejected oversized tool arguments."
                    : (() => {
                        try {
                          const parsed = JSON.parse(event.arguments);
                          return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                            ? null
                            : "Rejected malformed tool arguments.";
                        } catch {
                          return "Rejected malformed tool arguments.";
                        }
                      })();
          if (invalidReason) {
            yield { type: "tool-result", callId: event.callId || "invalid", ok: false, output: invalidReason };
            rejectedToolCall = true;
            continue;
          }
          toolCallCount += 1;
          if (toolCallCount > (options.maxToolCalls ?? MAX_TOOL_CALLS_PER_RUN)) {
            yield {
              type: "tool-result",
              callId: event.callId,
              ok: false,
              output: "Rejected tool call because this run reached its execution limit."
            };
            rejectedToolCall = true;
            continue;
          }
          seenCallIds.add(event.callId);
          const approval = bindApproval(event.callId, event.approval);
          pendingToolCalls.push({
            callId: event.callId,
            tool: event.tool,
            arguments: event.arguments,
            approval
          });
          yield { ...event, approval };
          continue;
        }
        yield event;
      }
    } catch (error) {
      const candidate = error as { code?: unknown };
      if (candidate?.code === "cancelled") {
        yield { type: "cancelled" };
        return;
      }
      yield transportErrorEvent(error);
      yield { type: "done", finishReason: "error" };
      return;
    }

    if (rejectedToolCall) {
      yield { type: "done", finishReason: "error" };
      return;
    }

    if (finishReason !== "tool-calls" || pendingToolCalls.length === 0) {
      yield { type: "done", finishReason };
      return;
    }

    // Append the assistant turn (with tool calls) + execute each tool. We mutate
    // the running message list in place (push) rather than spread-copying it on
    // every turn/tool-result, which was O(n) per append => O(n^2) over a run.
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: pendingToolCalls.map((call) => ({
        callId: call.callId,
        tool: call.tool,
        arguments: call.arguments
      }))
    });

    for (const call of pendingToolCalls) {
      if (options.shouldCancel?.()) {
        yield { type: "cancelled" };
        return;
      }
      try {
        const result = boundedToolOutput(await execute(call.approval, call.arguments));
        if (options.shouldCancel?.()) {
          yield { type: "cancelled" };
          return;
        }
        yield { type: "tool-result", callId: call.callId, ok: true, output: result };
        messages.push({ role: "tool", content: result, toolCallId: call.callId, toolName: call.tool });
      } catch (error) {
        const message = boundedToolOutput(
          error instanceof Error ? error.message : "Tool execution failed."
        );
        yield { type: "tool-result", callId: call.callId, ok: false, output: message };
        messages.push({ role: "tool", content: message, toolCallId: call.callId, toolName: call.tool });
      }
    }
  }

  yield { type: "done", finishReason: "length" };
}

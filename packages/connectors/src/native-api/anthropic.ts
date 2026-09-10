/**
 * Anthropic Messages API shaping + SSE parsing.
 *
 * Anthropic's stream uses `event:`/`data:` pairs and streams tool input as
 * incremental `input_json_delta` fragments that must be concatenated before the
 * tool call is complete. This parser buffers partial JSON per content-block
 * index and emits a single tool-call event when the block closes.
 *
 * Pure: no network, no key. Active egress is direct Anthropic API-key HTTP;
 * Vertex AI and Amazon Bedrock routing are future extensions.
 */

import type { BackendAgentEvent, NativeCompletionRequest } from "@fable/protocol";
import { buildToolApproval } from "./approvals";
import { hasKnownPrice, priceFor } from "./pricing";
import type { HttpTransport } from "./transport";
import { extractPayload, splitLines } from "./transport";

interface ToolBuffer {
  id: string;
  name: string;
  json: string;
}

/** Per-stream state carrying partial tool-input buffers across lines. */
export interface AnthropicStreamState {
  toolBuffers: Map<number, ToolBuffer>;
  inputTokens: number;
  terminalSeen: boolean;
}

/** Create fresh per-stream state. */
export function newAnthropicState(): AnthropicStreamState {
  return { toolBuffers: new Map(), inputTokens: 0, terminalSeen: false };
}

/** Shape a normalized request into the Anthropic Messages body. */
export function shapeAnthropicRequest(request: NativeCompletionRequest): unknown {
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const shaped = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.toolCallId) {
        // Tool results are delivered as user-role content blocks.
        return {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: message.toolCallId, content: message.content }
          ]
        };
      }
      if (message.role === "assistant" && message.toolCalls?.length) {
        return {
          role: "assistant",
          content: [
            ...(message.content ? [{ type: "text", text: message.content }] : []),
            ...message.toolCalls.map((call) => ({
              type: "tool_use",
              id: call.callId,
              name: call.tool,
              input: JSON.parse(call.arguments)
            }))
          ]
        };
      }
      return { role: message.role, content: message.content };
    });
  // Parallel tool results belong in the same user message immediately after
  // their assistant tool_use blocks. Native egress may add an image to a result.
  const messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }> = [];
  for (const message of shaped) {
    const previous = messages.at(-1);
    if (message.role === "user" && previous?.role === "user"
      && Array.isArray(message.content) && Array.isArray(previous.content)
      && message.content.every(block => block.type === "tool_result")
      && previous.content.every(block => block.type === "tool_result")) {
      previous.content = [...previous.content, ...message.content];
    } else messages.push(message);
  }

  return {
    model: request.model,
    max_tokens: request.maxTokens,
    ...(request.reasoningEffort ? { output_config: { effort: request.reasoningEffort } } : {}),
    stream: true,
    ...(system ? { system } : {}),
    messages,
    ...(request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: JSON.parse(tool.parameters)
          }))
        }
      : {})
  };
}

/**
 * Parse an Anthropic event/data pair into events. `state` carries the partial
 * tool-input buffer across lines; pass a fresh state per stream.
 */
export function parseAnthropicLine(
  dataLine: string,
  state: AnthropicStreamState = newAnthropicState()
): BackendAgentEvent[] {
  const payload = extractPayload(dataLine);
  if (!payload) return [];
  let chunk: Record<string, unknown>;
  try {
    chunk = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return [{ type: "error", message: "Unparseable Anthropic chunk." }];
  }
  if (chunk && typeof chunk === "object" && "error" in chunk) {
    return [{ type: "error", message: "Provider error." }];
  }

  const type = chunk.type as string;
  const events: BackendAgentEvent[] = [];

  if (type === "message_start") {
    const message = chunk.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, number> | undefined;
    state.inputTokens = usage?.input_tokens ?? 0;
  }

  if (type === "content_block_start") {
    const block = chunk.content_block as Record<string, unknown> | undefined;
    if (block?.type === "tool_use") {
      const index = (chunk.index as number) ?? 0;
      state.toolBuffers.set(index, {
        id: (block.id as string) ?? "",
        name: (block.name as string) ?? "",
        json: ""
      });
    }
  }

  if (type === "content_block_delta") {
    const delta = chunk.delta as Record<string, unknown> | undefined;
    if (delta?.type === "text_delta") {
      events.push({ type: "text-delta", text: delta.text as string });
    }
    if (delta?.type === "input_json_delta") {
      const index = (chunk.index as number) ?? 0;
      const buffer = state.toolBuffers.get(index);
      if (buffer) {
        buffer.json += (delta.partial_json as string) ?? "";
      }
    }
  }

  if (type === "content_block_stop") {
    const index = (chunk.index as number) ?? 0;
    const buffer = state.toolBuffers.get(index);
    if (buffer) {
      state.toolBuffers.delete(index);
      events.push({
        type: "tool-call",
        callId: buffer.id,
        tool: buffer.name,
        arguments: buffer.json || "{}",
        approval: buildToolApproval("anthropic", buffer.name, buffer.json || "{}")
      });
    }
  }

  if (type === "message_delta") {
    const delta = chunk.delta as Record<string, unknown> | undefined;
    const usage = chunk.usage as Record<string, number> | undefined;
    if (usage) {
      events.push({
        type: "usage",
        inputTokens: state.inputTokens,
        outputTokens: usage.output_tokens ?? 0,
        costUsd: priceFor("anthropic", state.inputTokens, usage.output_tokens ?? 0),
        costEstimated: true,
        costUnknown: !hasKnownPrice("anthropic")
      });
    }
    if (delta?.stop_reason) {
      state.terminalSeen = true;
      const reason = delta.stop_reason as string;
      events.push({
        type: "done",
        finishReason:
          reason === "tool_use" ? "tool-calls" : reason === "max_tokens" ? "length" : "stop"
      });
    }
  }

  if (type === "message_stop" && !state.terminalSeen) {
    // message_stop without a preceding message_delta still closes the stream.
    state.terminalSeen = true;
    events.push({ type: "done", finishReason: "stop" });
  }

  return events;
}

/** Stream the transport through the Anthropic parser (stateful across lines). */
export async function* streamAnthropicEvents(
  transport: HttpTransport,
  request: NativeCompletionRequest
): AsyncIterable<BackendAgentEvent> {
  const state = newAnthropicState();
  for await (const chunk of transport.stream(request)) {
    for (const line of splitLines(chunk)) {
      if (line.startsWith("event:")) {
        continue; // Anthropic event labels are informational; data carries the type.
      }
      for (const event of parseAnthropicLine(line, state)) {
        yield event;
      }
    }
  }
}

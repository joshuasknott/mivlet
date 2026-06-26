/**
 * Anthropic Messages API shaping + SSE parsing.
 *
 * Anthropic's stream uses `event:`/`data:` pairs and streams tool input as
 * incremental `input_json_delta` fragments that must be concatenated before the
 * tool call is complete. This parser buffers partial JSON per content-block
 * index and emits a single tool-call event when the block closes.
 *
 * Pure: no network, no key. Anthropic is API key / Vertex / Bedrock only —
 * compliance copy lives in the fixtures, not here.
 */

import type { BackendAgentEvent, NativeCompletionRequest } from "@arden/protocol";
import { buildToolApproval } from "./approvals";
import { priceFor } from "./pricing";
import type { HttpTransport } from "./transport";

interface ToolBuffer {
  id: string;
  name: string;
  json: string;
}

/** Per-stream state carrying partial tool-input buffers across lines. */
export interface AnthropicStreamState {
  toolBuffers: Map<number, ToolBuffer>;
}

/** Create fresh per-stream state. */
export function newAnthropicState(): AnthropicStreamState {
  return { toolBuffers: new Map() };
}

/** Shape a normalized request into the Anthropic Messages body. */
export function shapeAnthropicRequest(request: NativeCompletionRequest): unknown {
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const messages = request.messages
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
      return { role: message.role, content: message.content };
    });

  return {
    model: request.model,
    max_tokens: request.maxTokens,
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
  const payload = dataLine.startsWith("data:") ? dataLine.slice(5).trim() : dataLine.trim();
  if (!payload) return [];
  let chunk: Record<string, unknown>;
  try {
    chunk = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return [{ type: "error", message: "Unparseable Anthropic chunk." }];
  }

  const type = chunk.type as string;
  const events: BackendAgentEvent[] = [];

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
        inputTokens: 0,
        outputTokens: usage.output_tokens ?? 0,
        costUsd: priceFor("anthropic", 0, usage.output_tokens ?? 0)
      });
    }
    if (delta?.stop_reason) {
      const reason = delta.stop_reason as string;
      events.push({
        type: "done",
        finishReason:
          reason === "tool_use" ? "tool-calls" : reason === "max_tokens" ? "length" : "stop"
      });
    }
  }

  if (type === "message_stop" && events.length === 0) {
    // message_stop without a preceding message_delta still closes the stream.
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
  for await (const line of transport.stream(request)) {
    if (line.startsWith("event:")) {
      continue; // Anthropic event labels are informational; data carries the type.
    }
    if (line.startsWith("data:")) {
      for (const event of parseAnthropicLine(line, state)) {
        yield event;
      }
    }
  }
}

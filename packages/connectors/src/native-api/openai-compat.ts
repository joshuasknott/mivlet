/**
 * Shared OpenAI-compatible request shaping + SSE parsing.
 *
 * OpenAI, OpenRouter, and xAI all speak the Chat Completions wire format, so
 * they share this path. Anthropic Messages and Gemini have their own shapers
 * (anthropic.ts / gemini.ts) but produce the same BackendAgentEvent stream.
 *
 * Pure functions: no network, no key. The transport seam owns egress; the API
 * key is added as a Bearer header inside Rust only.
 */

import type { BackendAgentEvent, NativeCompletionRequest } from "@fable/protocol";
import { buildToolApproval } from "./approvals";
import { priceFor } from "./pricing";
import type { HttpTransport } from "./transport";

interface OpenAiToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface OpenAiChoiceDelta {
  content?: string;
  tool_calls?: OpenAiToolCallDelta[];
}
interface OpenAiChunk {
  choices?: Array<{ delta?: OpenAiChoiceDelta; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Shape a normalized request into the OpenAI chat-completions body. */
export function shapeOpenAiRequest(request: NativeCompletionRequest): unknown {
  const messages = request.messages.map((message) => {
    const base: Record<string, unknown> = { role: message.role, content: message.content };
    if (message.toolCallId) {
      base.tool_call_id = message.toolCallId;
    }
    return base;
  });

  return {
    model: request.model,
    messages,
    max_tokens: request.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: JSON.parse(tool.parameters)
            }
          }))
        }
      : {})
  };
}

function toToolCallEvent(providerId: string, raw: OpenAiToolCallDelta): BackendAgentEvent {
  const callId = raw.id ?? `call_${raw.index}`;
  const tool = raw.function?.name ?? "";
  const args = raw.function?.arguments ?? "{}";
  return {
    type: "tool-call",
    callId,
    tool,
    arguments: args,
    approval: buildToolApproval(providerId, tool, args)
  };
}

/** Parse a single OpenAI SSE line into zero or more normalized events. */
export function parseOpenAiLine(
  providerId: string,
  line: string
): BackendAgentEvent[] {
  const payload = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
  if (!payload || payload === "[DONE]") {
    return [];
  }
  let chunk: OpenAiChunk;
  try {
    chunk = JSON.parse(payload) as OpenAiChunk;
  } catch {
    return [{ type: "error", message: "Unparseable OpenAI chunk." }];
  }

  const events: BackendAgentEvent[] = [];
  const choice = chunk.choices?.[0];
  if (choice?.delta?.content) {
    events.push({ type: "text-delta", text: choice.delta.content });
  }
  if (choice?.delta?.tool_calls) {
    for (const raw of choice.delta.tool_calls) {
      events.push(toToolCallEvent(providerId, raw));
    }
  }
  if (chunk.usage) {
    const input = chunk.usage.prompt_tokens ?? 0;
    const output = chunk.usage.completion_tokens ?? 0;
    events.push({
      type: "usage",
      inputTokens: input,
      outputTokens: output,
      costUsd: priceFor(providerId, input, output)
    });
  }
  if (choice?.finish_reason) {
    const finish =
      choice.finish_reason === "tool_calls"
        ? "tool-calls"
        : choice.finish_reason === "length"
          ? "length"
          : "stop";
    events.push({ type: "done", finishReason: finish });
  }
  return events;
}

/** Stream the transport through the OpenAI parser into ordered events. */
export async function* streamOpenAiEvents(
  transport: HttpTransport,
  request: NativeCompletionRequest
): AsyncIterable<BackendAgentEvent> {
  for await (const line of transport.stream(request)) {
    for (const event of parseOpenAiLine(request.providerId, line)) {
      yield event;
    }
  }
}

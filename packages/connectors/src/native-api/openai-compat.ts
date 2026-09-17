/**
 * Shared OpenAI-compatible request shaping + SSE parsing.
 *
 * OpenAI, xAI, and explicit custom endpoints share the Chat Completions wire
 * format. Anthropic Messages and Gemini have their own shapers
 * (anthropic.ts / gemini.ts) but produce the same BackendAgentEvent stream.
 *
 * Pure functions: no network, no key. The transport seam owns egress; the API
 * key is added as a Bearer header inside Rust only.
 */

import type { BackendAgentEvent, NativeCompletionRequest } from "@mivlet/protocol";
import { buildToolApproval } from "./approvals";
import { hasKnownPrice, priceFor } from "./pricing";
import type { HttpTransport } from "./transport";
import { extractPayload, splitLines } from "./transport";

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
  error?: { message?: string };
}

/** Shape a normalized request into the OpenAI chat-completions body. */
export function shapeOpenAiRequest(request: NativeCompletionRequest): unknown {
  const messages = request.messages.map((message) => {
    const base: Record<string, unknown> = { role: message.role, content: message.content };
    if (message.role === "assistant" && message.toolCalls?.length) {
      base.tool_calls = message.toolCalls.map((call) => ({
        id: call.callId,
        type: "function",
        function: { name: call.tool, arguments: call.arguments }
      }));
    }
    if (message.toolCallId) {
      base.tool_call_id = message.toolCallId;
    }
    return base;
  });

  return {
    model: request.model,
    messages,
    ...(request.providerId === "openai" &&
    (request.model.startsWith("gpt-5") || request.model.startsWith("o"))
      ? { max_completion_tokens: request.maxTokens }
      : { max_tokens: request.maxTokens }),
    stream: true,
    stream_options: { include_usage: true },
    // DeepSeek never receives a reasoning_effort: thinking mode is disabled for
    // this route (see below) and the field would flip it back on at the API.
    ...(request.reasoningEffort && ["openai", "xai", "custom"].includes(request.providerId)
      ? { reasoning_effort: request.reasoningEffort }
      : {}),
    // DeepSeek thinking mode defaults to enabled and emits `reasoning_content`
    // deltas. Its documented contract then requires every later tool turn to
    // resend that reasoning_content or the API returns 400 (api-docs.deepseek.com
    // guides/thinking_mode "Tool Calls"). The shared shaper does not carry that
    // field, so DeepSeek runs in the documented non-thinking mode; the Rust
    // egress boundary enforces the same shape for the embedded host. Reasoning
    // levels are therefore not advertised and fail closed if requested.
    ...(["deepseek", "moonshot", "zai"].includes(request.providerId) ? { thinking: { type: "disabled" } } : {}),
    ...(request.providerId === "alibaba" ? { enable_thinking: false } : {}),
    ...(request.providerId === "openrouter" ? { provider: { require_parameters: true } } : {}),
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

interface OpenAiStreamState {
  toolCalls: Map<number, { index: number; id?: string; name: string; arguments: string }>;
}

/** Create fresh per-stream state. */
export function newOpenAiStreamState(): OpenAiStreamState {
  return { toolCalls: new Map() };
}

export function parseOpenAiStreamLine(
  providerId: string,
  line: string,
  state: OpenAiStreamState
): BackendAgentEvent[] {
  const payload = extractPayload(line);
  if (!payload) return [];
  let chunk: OpenAiChunk;
  try {
    chunk = JSON.parse(payload) as OpenAiChunk;
  } catch {
    return [{ type: "error", message: "Unparseable OpenAI chunk." }];
  }
  if (chunk?.error) {
    return [{ type: "error", message: "Provider error." }];
  }
  const events: BackendAgentEvent[] = [];
  const choice = chunk.choices?.[0];
  if (choice?.delta?.content) {
    events.push({ type: "text-delta", text: choice.delta.content });
  }
  for (const fragment of choice?.delta?.tool_calls ?? []) {
    const buffered = state.toolCalls.get(fragment.index) ?? {
      index: fragment.index,
      name: "",
      arguments: ""
    };
    if (fragment.id) buffered.id = fragment.id;
    if (fragment.function?.name) buffered.name += fragment.function.name;
    if (fragment.function?.arguments) buffered.arguments += fragment.function.arguments;
    state.toolCalls.set(fragment.index, buffered);
  }
  if (chunk.usage) {
    const input = chunk.usage.prompt_tokens ?? 0;
    const output = chunk.usage.completion_tokens ?? 0;
    events.push({
      type: "usage",
      inputTokens: input,
      outputTokens: output,
      costUsd: priceFor(providerId, input, output),
      costEstimated: true,
      costUnknown: !hasKnownPrice(providerId)
    });
  }
  if (choice?.finish_reason) {
    if (choice.finish_reason === "tool_calls") {
      for (const call of [...state.toolCalls.values()].sort((a, b) => a.index - b.index)) {
        events.push(
          toToolCallEvent(providerId, {
            index: call.index,
            id: call.id,
            function: { name: call.name, arguments: call.arguments || "{}" }
          })
        );
      }
      state.toolCalls.clear();
    }
    events.push({
      type: "done",
      finishReason:
        choice.finish_reason === "tool_calls"
          ? "tool-calls"
          : choice.finish_reason === "length"
            ? "length"
            : "stop"
    });
  }
  return events;
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
  const payload = extractPayload(line);
  if (!payload) {
    return [];
  }
  let chunk: OpenAiChunk;
  try {
    chunk = JSON.parse(payload) as OpenAiChunk;
  } catch {
    return [{ type: "error", message: "Unparseable OpenAI chunk." }];
  }
  if (chunk?.error) {
    return [{ type: "error", message: "Provider error." }];
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
      costUsd: priceFor(providerId, input, output),
      costEstimated: true,
      costUnknown: !hasKnownPrice(providerId)
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
  const state = newOpenAiStreamState();
  for await (const chunk of transport.stream(request)) {
    for (const line of splitLines(chunk)) {
      for (const event of parseOpenAiStreamLine(request.providerId, line, state)) {
        yield event;
      }
    }
  }
}

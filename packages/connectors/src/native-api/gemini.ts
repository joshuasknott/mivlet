/**
 * Gemini generateContent shaping + SSE parsing for the Google AI API key path.
 *
 * Gemini streams JSON-per-line (not SSE `data:` frames) and models tools as
 * `functionCall` parts. Compliance: no Google AI Pro/Ultra subscription reuse;
 * Vertex AI routing is a future extension.
 *
 * Rust owns the direct API-key host and credential injection; this shaper only
 * owns the body and event parse.
 */

import type { BackendAgentEvent, NativeCompletionRequest } from "@fable/protocol";
import { buildToolApproval } from "./approvals";
import { priceFor } from "./pricing";
import type { HttpTransport } from "./transport";
import { extractPayload, splitLines } from "./transport";

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
}
interface GeminiChunk {
  candidates?: Array<{
    content?: { role?: string; parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** Shape a normalized request into the Gemini generateContent body. */
export function shapeGeminiRequest(request: NativeCompletionRequest): unknown {
  const contents = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const role = message.role === "assistant" ? "model" : "user";
      const parts: Array<GeminiPart | Record<string, unknown>> = [];
      if (message.content) parts.push({ text: message.content });
      if (message.role === "assistant") {
        for (const call of message.toolCalls ?? []) {
          parts.push({
            functionCall: {
              name: call.tool,
              args: JSON.parse(call.arguments)
            }
          });
        }
      }
      if (message.role === "tool" && message.toolCallId) {
        parts.push({
          functionResponse: {
            name: message.toolName ?? message.toolCallId,
            response: { output: message.content }
          }
        });
      }
      return { role, parts };
    });

  const systemInstruction = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  return {
    contents,
    ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
    ...(request.tools.length > 0
      ? {
          tools: [
            {
              functionDeclarations: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: JSON.parse(tool.parameters)
              }))
            }
          ]
        }
      : {}),
    generationConfig: { maxOutputTokens: request.maxTokens }
  };
}

/** Parse a single Gemini JSON line into zero or more normalized events. */
export function parseGeminiLine(
  providerId: string,
  line: string
): BackendAgentEvent[] {
  const payload = extractPayload(line);
  if (!payload) return [];
  let chunk: GeminiChunk;
  try {
    chunk = JSON.parse(payload) as GeminiChunk;
  } catch {
    return [{ type: "error", message: "Unparseable Gemini chunk." }];
  }
  if (chunk && typeof chunk === "object" && "error" in (chunk as any)) {
    return [{ type: "error", message: "Provider error." }];
  }

  const events: BackendAgentEvent[] = [];
  const candidate = chunk.candidates?.[0];
  let hasFunctionCall = false;
  for (const part of candidate?.content?.parts ?? []) {
    if (part.text) {
      events.push({ type: "text-delta", text: part.text });
    }
    if (part.functionCall?.name) {
      hasFunctionCall = true;
      const args = JSON.stringify(part.functionCall.args ?? {});
      events.push({
        type: "tool-call",
        callId: part.functionCall.name,
        tool: part.functionCall.name,
        arguments: args,
        approval: buildToolApproval(providerId, part.functionCall.name, args)
      });
    }
  }
  if (chunk.usageMetadata) {
    const input = chunk.usageMetadata.promptTokenCount ?? 0;
    const output = chunk.usageMetadata.candidatesTokenCount ?? 0;
    events.push({
      type: "usage",
      inputTokens: input,
      outputTokens: output,
      costUsd: priceFor(providerId, input, output),
      costEstimated: true
    });
  }
  if (candidate?.finishReason) {
    const reason = candidate.finishReason;
    events.push({
      type: "done",
      finishReason:
        hasFunctionCall
          ? "tool-calls"
          : reason === "STOP"
          ? "stop"
          : reason === "MAX_TOKENS"
            ? "length"
            : "stop"
    });
  }
  return events;
}

/** Stream the transport through the Gemini parser. */
export async function* streamGeminiEvents(
  transport: HttpTransport,
  request: NativeCompletionRequest
): AsyncIterable<BackendAgentEvent> {
  for await (const chunk of transport.stream(request)) {
    for (const line of splitLines(chunk)) {
      for (const event of parseGeminiLine(request.providerId, line)) {
        yield event;
      }
    }
  }
}

/**
 * Gemini generateContent shaping + SSE parsing (Google AI API key + Vertex AI).
 *
 * Gemini streams JSON-per-line (not SSE `data:` frames) and models tools as
 * `functionCall` parts. Compliance: Gemini is API key / Vertex only — no Google
 * AI Pro/Ultra subscription reuse (copy lives in fixtures).
 *
 * The host (generativelanguage.googleapis.com vs a Vertex regional endpoint) is
 * selected by Rust from the provider id; this shaper only owns the body + the
 * event parse.
 */

import type { BackendAgentEvent, NativeCompletionRequest } from "@arden/protocol";
import { buildToolApproval } from "./approvals";
import { priceFor } from "./pricing";
import type { HttpTransport } from "./transport";

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
      const parts: GeminiPart[] = [{ text: message.content }];
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
  const payload = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
  if (!payload || payload === "[DONE]") return [];
  let chunk: GeminiChunk;
  try {
    chunk = JSON.parse(payload) as GeminiChunk;
  } catch {
    return [{ type: "error", message: "Unparseable Gemini chunk." }];
  }

  const events: BackendAgentEvent[] = [];
  const candidate = chunk.candidates?.[0];
  for (const part of candidate?.content?.parts ?? []) {
    if (part.text) {
      events.push({ type: "text-delta", text: part.text });
    }
    if (part.functionCall?.name) {
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
      costUsd: priceFor(providerId, input, output)
    });
  }
  if (candidate?.finishReason) {
    const reason = candidate.finishReason;
    events.push({
      type: "done",
      finishReason:
        reason === "STOP"
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
  for await (const line of transport.stream(request)) {
    for (const event of parseGeminiLine(request.providerId, line)) {
      yield event;
    }
  }
}

import type {
  ApprovalRequest,
  BackendAgentEvent,
  NativeCompletionRequest,
  NativeMessage,
  NativeToolCall
} from "@fable/protocol";
import type { HttpTransport } from "./transport";
import { extractPayload, splitLines } from "./transport";

interface OllamaStreamObject {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: Array<{
      function?: {
        name?: string;
        arguments?: unknown;
      };
    }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

function approvalForTool(tool: string): ApprovalRequest {
  return {
    id: `ollama-${tool}`,
    service: "ollama",
    action: tool,
    mode: "trusted-scope",
    riskLevel: "medium",
    dataUsed: ["workspace"],
    consequence: `Allows the local model to request ${tool}; Fable will ask before anything runs.`,
    requestedAt: new Date().toISOString(),
    decisions: ["once", "deny"]
  };
}

function finishReason(reason: string | undefined): "stop" | "tool-calls" | "length" | "error" {
  if (reason === "length") return "length";
  if (reason === "error") return "error";
  return "stop";
}

function toolCallsFrom(message: NativeMessage): NativeToolCall[] | undefined {
  return message.toolCalls?.map((call) => ({
    callId: call.callId,
    tool: call.tool,
    arguments: call.arguments
  }));
}

export function shapeOllamaChatRequest(request: NativeCompletionRequest): unknown {
  return {
    model: request.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      tool_call_id: message.toolCallId,
      tool_name: message.toolName,
      tool_calls: toolCallsFrom(message)?.map((call) => ({
        function: {
          name: call.tool,
          arguments: safeJsonObject(call.arguments)
        }
      }))
    })),
    tools: request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: safeJsonObject(tool.parameters)
      }
    })),
    stream: true,
    options: {
      num_predict: request.maxTokens
    }
  };
}

function safeJsonObject(value: string): unknown {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function* streamOllamaEvents(
  transport: HttpTransport,
  request: NativeCompletionRequest
): AsyncIterable<BackendAgentEvent> {
  let sawToolCall = false;
  let counter = 0;

  for await (const chunk of transport.stream(request)) {
    for (const line of splitLines(chunk)) {
      const payload = extractPayload(line);
      if (!payload) continue;
      let parsed: OllamaStreamObject;
      try {
        parsed = JSON.parse(payload) as OllamaStreamObject;
      } catch {
        yield {
          type: "error",
          message: "Ollama returned malformed streaming JSON.",
          code: "transport",
          retryable: false
        };
        yield { type: "done", finishReason: "error" };
        return;
      }
      if (parsed.error) {
        yield {
          type: "error",
          message: parsed.error,
          code: parsed.error.toLowerCase().includes("not found")
            ? "invalid-request"
            : "transport",
          retryable: false
        };
        yield { type: "done", finishReason: "error" };
        return;
      }
      const content = parsed.message?.content;
      if (content) {
        yield { type: "text-delta", text: content };
      }
      const toolCalls = parsed.message?.tool_calls ?? [];
      for (const call of toolCalls) {
        const tool = call.function?.name?.trim();
        if (!tool) continue;
        counter += 1;
        sawToolCall = true;
        const args =
          typeof call.function?.arguments === "string"
            ? call.function.arguments
            : JSON.stringify(call.function?.arguments ?? {});
        yield {
          type: "tool-call",
          callId: `ollama-${counter}`,
          tool,
          arguments: args,
          approval: approvalForTool(tool)
        };
      }
      if (parsed.done) {
        if (
          typeof parsed.prompt_eval_count === "number" ||
          typeof parsed.eval_count === "number"
        ) {
          yield {
            type: "usage",
            inputTokens: parsed.prompt_eval_count ?? 0,
            outputTokens: parsed.eval_count ?? 0,
            costUsd: 0,
            costEstimated: true
          };
        }
        yield {
          type: "done",
          finishReason: sawToolCall ? "tool-calls" : finishReason(parsed.done_reason)
        };
        return;
      }
    }
  }
}

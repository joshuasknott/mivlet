/** Transport-neutral MCP 2025-11-25 JSON-RPC framing. */

export const MCP_PROTOCOL_VERSION = "2025-11-25" as const;
export const MAX_MCP_FRAME_CHARACTERS = 10 * 1024 * 1024;

export type McpRequestId = string | number;

export interface McpError {
  code: number;
  message: string;
  data?: unknown;
}

export interface McpRequest {
  jsonrpc: "2.0";
  id: McpRequestId;
  method: string;
  params?: unknown;
}

export interface McpNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface McpResponse {
  jsonrpc: "2.0";
  id: McpRequestId;
  result?: unknown;
  error?: McpError;
}

export type McpFrame = McpRequest | McpNotification | McpResponse;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is McpRequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

export function isMcpRequest(frame: McpFrame): frame is McpRequest {
  return "id" in frame && "method" in frame;
}

export function isMcpNotification(frame: McpFrame): frame is McpNotification {
  return !("id" in frame) && "method" in frame;
}

export function isMcpResponse(frame: McpFrame): frame is McpResponse {
  return "id" in frame && !("method" in frame);
}

/** Parse one newline-delimited MCP stdio message without accepting log output. */
export function parseMcpLine(line: string): McpFrame | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_MCP_FRAME_CHARACTERS) return null;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isObject(value) || value.jsonrpc !== "2.0") return null;

  const hasId = "id" in value;
  const hasMethod = typeof value.method === "string" && value.method.length > 0;
  if (hasId && !validId(value.id)) return null;

  if (hasId && hasMethod) return value as unknown as McpRequest;
  if (!hasId && hasMethod) return value as unknown as McpNotification;
  if (hasId && !hasMethod) {
    const hasResult = "result" in value;
    const error = value.error;
    const validError =
      isObject(error) && typeof error.code === "number" && typeof error.message === "string";
    if (hasResult === validError) return null;
    return value as unknown as McpResponse;
  }
  return null;
}

export function encodeMcpFrame(frame: McpFrame): string {
  const encoded = JSON.stringify(frame);
  if (encoded.includes("\n") || encoded.length > MAX_MCP_FRAME_CHARACTERS) {
    throw new Error("MCP frame exceeds the supported single-line size limit.");
  }
  return `${encoded}\n`;
}


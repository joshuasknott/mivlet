/**
 * Bounded MCP JSON-RPC framing shared with the renderer.
 *
 * The renderer only parses and forwards already-authorized frames. Protocol
 * and discovery validation lives in sdk-client.ts, which is owned by the
 * bundled native host and never enters the desktop browser bundle.
 */

export const MCP_PROTOCOL_VERSION = "2025-11-25";
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
  params?: Record<string, unknown>;
}

export interface McpNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: "2.0";
  id: McpRequestId;
  result?: unknown;
  error?: McpError;
}

export type McpFrame = McpRequest | McpNotification | McpResponse;

export interface McpServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  completions?: object;
  logging?: object;
  [key: string]: unknown;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: McpServerCapabilities;
  serverInfo: { name: string; version: string; [key: string]: unknown };
  instructions?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is McpRequestId {
  return (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isFinite(value));
}

function hasValidParams(value: Record<string, unknown>): boolean {
  return value.params === undefined || isRecord(value.params);
}

export function isMcpRequest(frame: McpFrame): frame is McpRequest {
  return isRecord(frame) &&
    frame.jsonrpc === "2.0" &&
    isRequestId(frame.id) &&
    typeof frame.method === "string" &&
    frame.method.length > 0 &&
    hasValidParams(frame);
}

export function isMcpNotification(frame: McpFrame): frame is McpNotification {
  return isRecord(frame) &&
    frame.jsonrpc === "2.0" &&
    typeof frame.method === "string" &&
    frame.method.length > 0 &&
    !("id" in frame) &&
    hasValidParams(frame);
}

export function isMcpResponse(frame: McpFrame): frame is McpResponse {
  if (!isRecord(frame) || frame.jsonrpc !== "2.0" || !isRequestId(frame.id)) return false;
  const hasResult = "result" in frame;
  const hasError = "error" in frame;
  if (hasResult === hasError) return false;
  if (!hasError) return true;
  const error = frame.error;
  return isRecord(error) && typeof error.code === "number" && Number.isFinite(error.code) &&
    typeof error.message === "string";
}

/** Parse one newline-delimited MCP message without accepting log output. */
export function parseMcpLine(line: string): McpFrame | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_MCP_FRAME_CHARACTERS) return null;

  try {
    const value: unknown = JSON.parse(trimmed);
    if (!isRecord(value)) return null;
    const frame = value as unknown as McpFrame;
    return isMcpRequest(frame) || isMcpNotification(frame) || isMcpResponse(frame) ? frame : null;
  } catch {
    return null;
  }
}

export function encodeMcpFrame(frame: McpFrame): string {
  if (!isMcpRequest(frame) && !isMcpNotification(frame) && !isMcpResponse(frame)) {
    throw new Error("MCP frame is invalid.");
  }
  const body = JSON.stringify(frame);
  if (body === undefined || body.includes("\n") || body.length > MAX_MCP_FRAME_CHARACTERS) {
    throw new Error("MCP frame exceeds the supported single-line size limit.");
  }
  return `${body}\n`;
}

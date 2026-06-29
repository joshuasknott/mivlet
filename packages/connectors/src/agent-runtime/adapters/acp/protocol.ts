/**
 * Generic ACP (Agent Client Protocol) JSON-RPC framing.
 *
 * ACP is a provider-neutral protocol spoken over stdio as newline-delimited
 * JSON-RPC 2.0 messages. Cursor and Grok each ship a CLI that speaks it; Fable
 * normalizes the frames into its provider-neutral {@link BackendAgentEvent}
 * stream. This module is **pure framing** — it knows nothing about Cursor,
 * Grok, processes, or auth. It only parses/encodes the wire envelope so the
 * session, events, and approvals layers can be fixture-tested without a socket.
 *
 * A frame is one of three JSON-RPC shapes:
 *   - request:       `{ jsonrpc, id, method, params }`
 *   - response:      `{ jsonrpc, id, result } | { jsonrpc, id, error }`
 *   - notification:  `{ jsonrpc, method, params }` (no id — streamed events)
 *
 * Defensive parsing: a malformed, non-JSON, oversized, or non-conforming line
 * yields `null` so the session loop can skip it without raising. The adapter
 * must never crash on a hostile or partial CLI stream.
 */

/** A JSON-RPC error object. */
export interface AcpError {
  code: number;
  message: string;
  data?: unknown;
}

/** A JSON-RPC 2.0 request. */
export interface AcpRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

/** A JSON-RPC 2.0 response (either a result or an error). */
export type AcpResponse = {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: AcpError;
};

/** A JSON-RPC 2.0 notification (no id — server-pushed streamed events). */
export interface AcpNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** Any ACP wire frame. */
export type AcpFrame = AcpRequest | AcpResponse | AcpNotification;

/**
 * The maximum size of a single framed line. Bounds a hostile or pathological
 * CLI so the session loop's buffers cannot be exhausted.
 */
export const MAX_ACP_FRAME_CHARACTERS = 1 * 1024 * 1024;

const JSONRPC_VERSION = "2.0";

/** True when the parsed value is a JSON object (not array/primitive). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Type guards so callers can narrow a parsed {@link AcpFrame}. */
export function isAcpRequest(frame: AcpFrame | null): frame is AcpRequest {
  return (
    frame !== null &&
    "id" in frame &&
    "method" in frame &&
    typeof frame.method === "string"
  );
}

export function isAcpResponse(frame: AcpFrame | null): frame is AcpResponse {
  return frame !== null && "id" in frame && !("method" in frame);
}

export function isAcpNotification(frame: AcpFrame | null): frame is AcpNotification {
  return frame !== null && "method" in frame && !("id" in frame);
}

/**
 * Parse a single newline-delimited stdio line into an {@link AcpFrame}, or null
 * when the line is blank, a comment, non-JSON, malformed, oversized, or not a
 * conforming JSON-RPC 2.0 frame.
 *
 * @param line One raw line read from the CLI's stdout/stderr.
 */
export function parseAcpLine(line: string): AcpFrame | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith(":")) {
    return null;
  }
  if (trimmed.length > MAX_ACP_FRAME_CHARACTERS) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isObject(parsed)) {
    return null;
  }
  if (parsed.jsonrpc !== JSONRPC_VERSION) {
    return null;
  }

  const hasId = "id" in parsed;
  const hasMethod = "method" in parsed && typeof parsed.method === "string";
  const hasResult = "result" in parsed;
  const hasError = "error" in parsed;

  // request: has id + method
  if (hasId && hasMethod) {
    return { jsonrpc: JSONRPC_VERSION, ...parsed } as unknown as AcpRequest;
  }
  // response: has id, no method, and a result or error
  if (hasId && !hasMethod && (hasResult || hasError)) {
    return { jsonrpc: JSONRPC_VERSION, ...parsed } as unknown as AcpResponse;
  }
  // notification: no id, has method
  if (!hasId && hasMethod) {
    return { jsonrpc: JSONRPC_VERSION, ...parsed } as unknown as AcpNotification;
  }
  return null;
}

/**
 * Encode a frame as a single newline-terminated JSON line for the CLI's stdin.
 * Throws if the encoded form exceeds the frame-size bound (the caller must not
 * hand the CLI an unbounded payload).
 */
export function encodeAcpFrame(frame: AcpFrame): string {
  const encoded = `${JSON.stringify(frame)}\n`;
  if (encoded.length > MAX_ACP_FRAME_CHARACTERS) {
    throw new Error("ACP frame exceeds the supported size limit.");
  }
  return encoded;
}

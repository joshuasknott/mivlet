/**
 * Tiny fake helpers used by the ACP unit tests. Kept separate from production
 * code so the fixtures never ship to consumers. They build conforming JSON-RPC
 * frames and a scripted in-memory transport without touching a real process.
 */

import type { AcpFrame, AcpNotification, AcpRequest, AcpResponse } from "./protocol";

/** Build a JSON-RPC notification (the streamed event shape). */
export function notification(method: string, params: unknown): AcpNotification {
  return { jsonrpc: "2.0", method, params };
}

/** Build a JSON-RPC request. */
export function request(id: string | number, method: string, params?: unknown): AcpRequest {
  return { jsonrpc: "2.0", id, method, params };
}

/** Build a JSON-RPC success response. */
export function response(id: string | number, result: unknown): AcpResponse {
  return { jsonrpc: "2.0", id, result };
}

/** Build a JSON-RPC error response. */
export function errorResponse(id: string | number, code: number, message: string): AcpResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Coerce a value to the frame union for scripted sequences. */
export function asFrame(frame: AcpFrame): AcpFrame {
  return frame;
}

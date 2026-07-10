/**
 * The ACP transport seam.
 *
 * The ACP adapter consumes this interface instead of spawning a process itself.
 * In production the desktop shell supplies a Tauri-bound transport that owns
 * the CLI child process + auth broker on the Rust side (mirroring native-API's
 * `createDesktopTransport`). In tests, a scripted `FakeAcpTransport` drives the
 * protocol. **A CLI is never spawned from JavaScript** — that stays behind the
 * Rust process boundary so secrets remain CLI-owned and no socket is opened in
 * a fixture.
 *
 * The transport speaks JSON-RPC 2.0 over stdio:
 *   - `send()` writes a frame to the CLI's stdin.
 *   - `request()` writes a request frame and awaits the matching response
 *     (correlated by id), returning a discriminated `AcpReply`.
 *   - `frames()` yields the streamed notification frames the CLI emits.
 *   - `close()` best-effort shuts the CLI down (Rust kills the child).
 *
 * This module holds only the interface + result type — pure and browser-safe.
 */

import type { AcpError, AcpFrame, AcpNotification, AcpRequest } from "./protocol";

/** Frames initiated by the agent: notifications and server-to-client requests. */
export type AcpInboundFrame = AcpNotification | AcpRequest;

/**
 * A request-response reply. The transport correlates the response to the
 * request id; the session treats `ok: false` as a recoverable protocol error
 * (it carries the JSON-RPC error, never a secret).
 */
export type AcpReply =
  | { ok: true; result?: unknown }
  | { ok: false; error: AcpError };

/**
 * A provider-neutral stdio/JSON-RPC transport for an ACP CLI.
 *
 * Implementations own the actual process pipe (Rust in production); this
 * interface keeps the adapter fixture-testable.
 */
export interface AcpTransport {
  /** Absolute workspace directory supplied to `session/new`. */
  readonly cwd: string;
  /** Send a frame to the CLI's stdin (fire-and-forget; no reply awaited). */
  send(frame: AcpFrame): Promise<void>;
  /** Send a request frame and await the matching JSON-RPC response. */
  request(req: AcpRequest): Promise<AcpReply>;
  /** Streamed agent notifications and server-to-client requests. */
  frames(): AsyncIterable<AcpInboundFrame>;
  /** Best-effort shutdown of the underlying process. */
  close(): Promise<void>;
}

/**
 * Build an {@link AcpTransport} for a connected ACP provider, or null when there
 * is no egress path (browser preview, no CLI spawned). The desktop supplies a
 * Tauri-bound factory that owns the CLI child process on the Rust side; tests
 * inject a scripted fake. Holds NO secret — auth is CLI-owned.
 */
export type AcpTransportFactory = (provider: AcpTransportProvider) => AcpTransport | null;

/** The provider metadata the ACP factory needs (kept minimal, secret-free). */
export interface AcpTransportProvider {
  readonly id: string;
}

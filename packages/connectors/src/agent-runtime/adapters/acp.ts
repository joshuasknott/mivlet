/**
 * ACP `AgentBackend` adapter — stub.
 *
 * ACP (backendType `acp`) is the generic stdio/JSON-RPC agent protocol shared
 * by Cursor and Grok. Auth is a user-installed CLI (CLI-owned; Fable never
 * holds it). Until a CLI is bundled and the JSON-RPC transport lands, ACP
 * backends report `install-required` and have no execution path.
 *
 * This stub returns null. When the real adapter lands it must:
 *   - implement `AgentBackend.run` over the CLI's JSON-RPC stream, yielding
 *     `BackendAgentEvent` (normalize the CLI's tool/approval events into Fable's
 *     approval queue via the `execute` seam);
 *   - spawn the CLI ONLY through a dedicated Rust command (process + auth
 *     broker), never from JavaScript — secrets stay CLI-owned or in the Rust
 *     auth cache, never in the TS contract;
 *   - report capabilities/entitlements the CLI actually surfaced (fail-closed).
 */

import type { AgentBackend, BackendDeps } from "../contract";
import type { BackendProvider } from "@fable/protocol";

/** ACP (Cursor/Grok) has no live execution path yet; metadata-only. */
export function resolveAcpBackend(
  _provider: BackendProvider,
  _deps: BackendDeps
): AgentBackend | null {
  return null;
}

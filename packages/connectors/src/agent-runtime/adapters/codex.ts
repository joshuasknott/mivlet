/**
 * Codex app-server `AgentBackend` adapter — stub.
 *
 * Codex (backendType `codex-app-server`) is a subscription (ChatGPT) or
 * BYOK-OpenAI-key backend that reaches its own app-server. It is NOT the
 * foundation of Fable's runtime — it is one future adapter.
 *
 * This stub returns null so the factory reports Codex as metadata-only until
 * its real adapter lands. When it does, it must:
 *   - implement `AgentBackend.run` by driving the Codex app-server protocol and
 *     yielding the same `BackendAgentEvent` stream (text/tool/usage/done/…);
 *   - reach auth ONLY through the Rust boundary or Codex's provider-owned auth
 *     cache (never hold a token in the adapter's fields, never pass one through
 *     the TS contract);
 *   - route tool calls through Fable's shared approval queue (the contract's
 *     `execute` seam) — Codex must not auto-execute side effects;
 *   - expose truthful entitlements via `listModels` only after a real check.
 *
 * The egress command must be Codex-specific (its own Tauri command / process
 * boundary), NOT a generic "run any backend" path that could funnel secrets.
 */

import type { AgentBackend, BackendDeps } from "../contract";
import type { BackendProvider } from "@fable/protocol";

/** Codex has no live execution path yet; the factory treats it as metadata-only. */
export function resolveCodexBackend(
  _provider: BackendProvider,
  _deps: BackendDeps
): AgentBackend | null {
  return null;
}

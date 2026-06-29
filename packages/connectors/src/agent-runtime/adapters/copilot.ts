/**
 * Copilot SDK `AgentBackend` adapter — stub.
 *
 * Copilot (backendType `copilot-sdk`) authenticates as a subscriber, an OAuth
 * app, an automation token, or BYOK, and runs through GitHub's Copilot SDK.
 * Until the SDK transport lands, Copilot is metadata-only.
 *
 * This stub returns null. When the real adapter lands it must:
 *   - implement `AgentBackend.run` over the Copilot SDK stream, yielding
 *     `BackendAgentEvent` and routing tool calls through Fable's approval queue;
 *   - reach auth ONLY through the Rust boundary / Copilot's provider-owned auth
 *     cache (OAuth tokens never enter the TS contract or React state);
 *   - expose entitlements only after a real post-login check.
 */

import type { AgentBackend, BackendDeps } from "../contract";
import type { BackendProvider } from "@fable/protocol";

/** Copilot has no live execution path yet; metadata-only. */
export function resolveCopilotBackend(
  _provider: BackendProvider,
  _deps: BackendDeps
): AgentBackend | null {
  return null;
}

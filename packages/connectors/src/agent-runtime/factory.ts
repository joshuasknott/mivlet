/**
 * The `AgentBackend` factory: resolves a `BackendProvider` to a live agent
 * backend (or null) by dispatching on `backendType`.
 *
 * Today only `native-api` returns a live backend. Codex, ACP, and Copilot are
 * metadata-only (their adapters return null until landed). The factory also
 * returns null for any backend that is not connected or lacks the `streaming`
 * capability — so the shell's "is there a backend to drive a run?" predicate is
 * preserved by construction.
 *
 * The factory is pure: it holds no state and performs no I/O. All egress + auth
 * flows through the injected {@link BackendDeps}.
 */

import type { BackendCapability, BackendProvider } from "@fable/protocol";
import type { AgentBackend, BackendDeps } from "./contract";
import { createNativeApiBackend } from "./adapters/native-api";
import { resolveCodexBackend } from "./adapters/codex";
import { resolveAcpBackend } from "./adapters/acp";
import { resolveCopilotBackend } from "./adapters/copilot";

/** A backend must be connected AND report streaming to be runnable. */
function isRunnable(provider: BackendProvider): boolean {
  if (provider.authState !== "connected") return false;
  const caps: readonly BackendCapability[] = provider.capabilities;
  return caps.includes("streaming");
}

/**
 * True when a backend family has a *live* adapter the factory can resolve today.
 *
 * This is the provider-neutral "can Fable actually drive a run on this backend
 * right now?" predicate. Today only `native-api` returns true: Codex, ACP, and
 * Copilot are metadata-only until their adapters land. The shell uses this to
 * decide whether the composer drives the agent loop vs. the knowledge-search
 * fallback — preserving the legacy native-API-only behavior while keeping the
 * contract ready for future adapters (flip a backend type here once it ships).
 *
 * Note: this checks the backend family's adapter readiness, not the per-instance
 * connection state. Pair with a connected + streaming check (as {@link
 * resolveAgentBackend} does) for the full "runnable now" answer.
 */
export function hasRunnableAdapter(backendType: string): boolean {
  // native-api and acp (Cursor/Grok) have live adapters. The ACP adapter is
  // inert until a CLI connects (no ACP provider can reach `connected` without
  // the CLI probe + egress wiring), so this flip preserves current shell
  // behavior while keeping the contract ready for a connected ACP provider.
  return backendType === "native-api" || backendType === "acp";
}

/**
 * Resolve the agent backend for a provider, or null when there is no execution
 * path. Callers (the shell) treat null as "no backend to drive the agent loop"
 * and fall back to the non-agent knowledge-search path — preserving the legacy
 * `connectedNativeBackend` behavior exactly.
 */
export function resolveAgentBackend(
  provider: BackendProvider | undefined,
  deps: BackendDeps
): AgentBackend | null {
  if (!provider || !isRunnable(provider)) return null;
  switch (provider.backendType) {
    case "native-api":
      // Fable owns the full loop here; transport + discovery injected via deps.
      return createNativeApiBackend(provider, deps);
    case "codex-app-server":
      // Metadata-only until the Codex app-server adapter lands.
      return resolveCodexBackend(provider, deps);
    case "acp":
      // Metadata-only until the ACP (Cursor/Grok) JSON-RPC adapter lands.
      return resolveAcpBackend(provider, deps);
    case "copilot-sdk":
      // Metadata-only until the Copilot SDK adapter lands.
      return resolveCopilotBackend(provider, deps);
    default:
      // Unknown backend type: fail-closed (no execution path).
      return null;
  }
}

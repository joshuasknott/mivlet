/**
 * The `AgentBackend` factory: resolves a `BackendProvider` to a live agent
 * backend (or null) by dispatching on `backendType`.
 *
 * Native HTTP, Codex, ACP, and supervised provider-owned command drivers can
 * return live backends. The factory returns null for any backend that is not
 * connected or lacks the `streaming` capability — so the shell's "is there a
 * backend to drive a run?" predicate is preserved by construction.
 *
 * The factory is pure: it holds no state and performs no I/O. All egress + auth
 * flows through the injected {@link BackendDeps}.
 */

import type { BackendCapability, BackendProvider } from "@fable/protocol";
import type { AgentBackend, BackendDeps } from "./contract";
import { createRegisteredBackend, hasRegisteredAdapter } from "./adapter-registry";

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
 * right now?" predicate. The shell uses this to decide whether the composer
 * drives the agent loop or the knowledge-search fallback.
 *
 * Note: this checks the backend family's adapter readiness, not the per-instance
 * connection state. Pair with a connected + streaming check (as {@link
 * resolveAgentBackend} does) for the full "runnable now" answer.
 */
export function hasRunnableAdapter(driverKind: string): boolean {
  return hasRegisteredAdapter(driverKind);
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
  return createRegisteredBackend(provider, deps);
}

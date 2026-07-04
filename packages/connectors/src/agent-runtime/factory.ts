/**
 * The `AgentBackend` factory: resolves a `BackendProvider` to a live agent
 * backend (or null) by dispatching on `backendType`.
 *
 * Today `native-api`, Codex app-server, and ACP return live backends. Copilot
 * is metadata-only (its adapter returns null until landed). The factory also
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
import { createLocalLoopbackBackend } from "./adapters/local-loopback";

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
 * right now?" predicate. Native API, Codex, and ACP return true; Copilot is
 * metadata-only until its adapter lands. The shell uses this to
 * decide whether the composer drives the agent loop vs. the knowledge-search
 * fallback — preserving the legacy native-API-only behavior while keeping the
 * contract ready for future adapters (flip a backend type here once it ships).
 *
 * Note: this checks the backend family's adapter readiness, not the per-instance
 * connection state. Pair with a connected + streaming check (as {@link
 * resolveAgentBackend} does) for the full "runnable now" answer.
 */
export function hasRunnableAdapter(backendType: string): boolean {
  return (
    backendType === "native-api" ||
    backendType === "codex-app-server" ||
    backendType === "acp" ||
    backendType === "local-loopback"
  );
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
      // Codex owns auth + process protocol; Fable maps it into AgentBackend.
      return resolveCodexBackend(provider, deps);
    case "acp":
      // ACP providers own auth in their CLIs; Fable maps the JSON-RPC stream.
      return resolveAcpBackend(provider, deps);
    case "local-loopback":
      // Externally managed literal-loopback runtimes such as Ollama.
      return createLocalLoopbackBackend(provider, deps);
    case "copilot-sdk":
      // Metadata-only until the Copilot SDK adapter lands.
      return resolveCopilotBackend(provider, deps);
    default:
      // Unknown backend type: fail-closed (no execution path).
      return null;
  }
}

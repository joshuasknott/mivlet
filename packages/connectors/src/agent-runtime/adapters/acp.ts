/**
 * ACP `AgentBackend` adapter for every catalog-declared ACP CLI.
 *
 * Implements the provider-neutral {@link AgentBackend} contract for the ACP
 * (Agent Client Protocol) family: a user-installed CLI speaks JSON-RPC over
 * stdio, and this adapter normalizes its events into Fable's universal
 * {@link BackendAgentEvent} stream. Auth is **CLI-owned** — Fable never holds a
 * subscription token. The adapter consumes an injected {@link AcpTransport}
 * (built by `deps.createAcpTransport`); it never spawns a process itself. The
 * desktop shell wires that factory to a dedicated Rust command that owns the
 * CLI child process + auth broker, mirroring the native-API egress boundary.
 *
 * SECRET INVARIANT: the adapter holds no key, no token. The transport it
 * receives owns the process pipe; in production Rust brokers the CLI's auth so
 * the secret never crosses into JavaScript. The adapter only shapes the
 * key-free run request and normalizes the CLI's events.
 *
 * The generic ACP protocol handling lives in `./acp/*` (framing, events,
 * approvals, transport, session) and is provider-neutral — it never references
 * "cursor"/"grok". Provider-specific executable discovery + capability
 * declarations live in `./acp-providers`.
 */

import type {
  AgentTurnOptions,
  AgentTurnRequest,
  BackendAgentEvent,
  BackendCapability,
  BackendProvider
} from "@fable/protocol";
import type { ModelDiscoveryResult } from "../../native-api/discovery";
import type { AgentBackend, BackendDeps } from "../contract";
import { runAcpSession } from "./acp/session";
import type { AcpTransport } from "./acp/transport";

/** The bound transport + cancel for the most recent run (one live run per backend). */
interface ActiveRun {
  transport: AcpTransport;
}

/** A backend must be connected AND report streaming to be runnable. */
function isRunnableAcp(provider: BackendProvider): boolean {
  if (provider.authState !== "connected") return false;
  return provider.capabilities.includes("streaming");
}

/**
 * Build the ACP agent backend for a connected ACP provider.
 *
 * @param provider The connected ACP BackendProvider (cursor or grok).
 * @param deps Injected ACP transport factory (+ optional model discovery).
 *   The desktop wires `createAcpTransport` to the Rust CLI-spawn boundary;
 *   tests inject a scripted fake. Returns null when the provider is not
 *   connected/streaming, or when no ACP transport factory is wired.
 */
export function resolveAcpBackend(
  provider: BackendProvider,
  deps: BackendDeps
): AgentBackend | null {
  if (!isRunnableAcp(provider)) return null;
  if (!deps.createAcpTransport) return null;

  const capabilities: readonly BackendCapability[] = provider.capabilities;
  // The most recent run's transport. One backend instance drives one live run at
  // a time (the shell guards this); cancel() drops it at the boundary.
  let active: ActiveRun | null = null;

  function run(
    request: AgentTurnRequest,
    options: AgentTurnOptions
  ): AsyncIterable<BackendAgentEvent> | null {
    const transport = deps.createAcpTransport!({ id: provider.id });
    if (transport === null) return null;
    active = { transport };

    return runAcpSession(transport, provider.id, request, {
      execute: options.execute,
      shouldCancel: options.shouldCancel,
      contextPrefix: options.contextPrefix,
      maxTurns: options.maxTurns,
      maxToolCalls: options.maxToolCalls,
      maxToolOutputCharacters: options.maxToolOutputCharacters
    });
  }

  async function cancel(_runId: string): Promise<void> {
    // The adapter tracks its own active transport internally. The runId argument
    // is accepted for contract conformance; cancellation closes the transport so
    // the CLI child process is dropped at the Rust boundary.
    if (active?.transport) {
      await active.transport.close().catch(() => {
        /* best-effort: the CLI may already be gone */
      });
    }
    active = null;
  }

  async function listModels(): Promise<ModelDiscoveryResult> {
    // ACP CLI providers expose a fixed entitlement set (or none); there is no
    // list-models endpoint to probe. Report unsupported truthfully rather than
    // inventing a discovery path.
    return {
      outcome: "unsupported",
      models: [],
      message: "ACP providers do not expose dynamic model discovery."
    };
  }

  return {
    backend: provider,
    providerId: provider.id,
    capabilities,
    run,
    cancel,
    listModels
  };
}

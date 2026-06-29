/**
 * Provider-neutral `AgentBackend` runtime contract.
 *
 * One interface, every backend family. The shell resolves one AgentBackend per
 * run and consumes its `BackendAgentEvent` stream uniformly — it never branches
 * on provider ids or `BackendType`. Native-API is the first concrete adapter;
 * Codex app-server, ACP (Cursor/Grok), and Copilot SDK each get a future
 * adapter that implements this same contract.
 *
 * The contract is deliberately minimal and shaped to match the seams the
 * native-API loop already proved out:
 *   - `run()` yields the same `BackendAgentEvent` stream (text deltas, tool
 *     calls routed through Fable's approval queue, tool results, usage,
 *     done/error/cancelled).
 *   - `cancel()` best-effort drops the in-flight run.
 *   - `listModels()` exposes the selectable model set (optional — a backend may
 *     report a fixed entitlement set or none at all).
 *
 * SECRET INVARIANT: an `AgentBackend` and its request types carry NO key, NO
 * token, NO credential. Auth lives behind the Rust boundary or a provider-owned
 * auth cache. Adapters must not store secrets in their fields.
 *
 * This module is browser-safe and pure: no network, no Tauri import. The
 * transport + discovery seams are injected via {@link BackendDeps} so production
 * (desktop) and tests wire different implementations while the contract stays
 * fixture-testable.
 */

import type {
  AgentRunOptions,
  AgentRunRequest,
  BackendAgentEvent,
  BackendCapability,
  BackendProvider
} from "@fable/protocol";
import type { HttpTransport } from "../native-api/transport";
import type { ModelDiscoveryResult } from "../native-api/discovery";

/**
 * A provider-neutral agent runtime. Native-API, Codex, ACP, and Copilot each
 * implement this. The shell resolves one AgentBackend per run via the factory
 * and consumes its events uniformly.
 */
export interface AgentBackend {
  /** The backend metadata this adapter runs for. */
  readonly backend: BackendProvider;
  readonly providerId: string;
  /** The closed capability set this adapter honors at its current auth state. */
  readonly capabilities: readonly BackendCapability[];

  /**
   * Stream a prompt turn. Yields the same normalized `BackendAgentEvent`
   * stream every backend family speaks. Model tool calls arrive as `tool-call`
   * carrying a pre-shaped `ApprovalRequest` so they route through Fable's
   * approval queue before the adapter executes them.
   *
   * Returns `null` when the backend cannot construct an egress path for this
   * run (no transport in browser preview, no installed runtime). The shell
   * surfaces this as a no-transport notice instead of attempting the run.
   */
  run(
    request: AgentRunRequest,
    options: AgentRunOptions
  ): AsyncIterable<BackendAgentEvent> | null;

  /**
   * Best-effort in-flight cancellation of the run with the given id. Real
   * cancellation happens at the egress boundary (Rust for native-API); this is
   * the provider-neutral entry point the shell calls.
   */
  cancel(runId: string): Promise<void>;

  /**
   * Discover selectable models. Optional: a backend may report a fixed
   * entitlement set (Codex subscription) or none at all (ACP CLI). The outcome
   * is always truthful (success/empty/unsupported/offline/failed).
   */
  listModels?(): Promise<ModelDiscoveryResult>;
}

/**
 * Dependency bag the desktop shell injects so `@fable/connectors` stays pure
 * (no network, no Tauri import). The native-API adapter uses `createTransport`
 * to build its HTTP/SSE seam over the Rust boundary; tests inject a
 * `FixtureTransport`. The returned transport is paired with a cancel handle so
 * the adapter can wire `cancel()` to the requestId held by the Rust cancel map.
 */
export interface BackendDeps {
  /**
   * Build the HTTP/SSE transport for a connected native-API backend, or null
   * when there is no egress path (browser preview, tests). The callbacks let
   * the shell observe the per-run requestId (for the Rust cancel map) and
   * transport retries (for the persisted-run "retrying" status).
   */
  createTransport: (
    provider: BackendProvider,
    handlers: TransportHandlers
  ) => TransportHandle | null;
  /** Optional model discovery wired to the Rust `list_backend_models` command. */
  discoverModels?: (providerId: string) => Promise<ModelDiscoveryResult | null>;
}

/**
 * Per-run callbacks the transport invokes. Provider-neutral: any egress-bound
 * backend signals when its request started (so cancel can target it) and when
 * it is retrying after a transient failure.
 */
export interface TransportHandlers {
  /** Called once with the requestId the egress boundary assigned to this run. */
  onRequestStarted: (requestId: string) => void;
  /** Called when the egress boundary is retrying after a transient failure. */
  onRetry: () => void;
}

/**
 * The transport + cancel pair the native-API adapter runs a turn over. The
 * `transport` side is the pure {@link HttpTransport} the loop consumes; the
 * `cancel` side drops the in-flight request at the egress boundary (Rust's
 * cancel map in production).
 *
 * Kept transport-agnostic so future native-API variants (e.g. a mocked socket)
 * can supply their own cancel without touching the adapter.
 */
export interface TransportHandle {
  /** The streaming transport the agent loop drives. */
  readonly transport: HttpTransport;
  /** Drop the in-flight request for the given requestId at the egress boundary. */
  cancel: (requestId: string) => Promise<void>;
}

/**
 * Resolve a `BackendProvider` to a live `AgentBackend`, or null when the backend
 * family has no execution path yet (not connected, no streaming capability, or a
 * metadata-only backend like Codex/ACP/Copilot before their adapter lands).
 *
 * Provided here as a type for the factory return; the concrete dispatch lives in
 * `factory.ts`.
 */
export type AgentBackendFactory = (
  provider: BackendProvider,
  deps: BackendDeps
) => AgentBackend | null;

export type { AgentRunRequest, AgentRunOptions } from "@fable/protocol";

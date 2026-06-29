/**
 * Scheduled-prompt execution through the provider-neutral `AgentBackend`.
 *
 * This is the headless execution path for scheduled runs: it drives an
 * `AgentBackend.run()` stream to completion and maps the outcome into a typed
 * `ScheduledExecutionResult` the shell reports back to the Rust queue. It is
 * deliberately provider-neutral — the same code runs native-API and Codex
 * app-server backends — and pure (no Tauri, no network, no clock): every side
 * effect (egress, cancellation, tool execution, tool-call surfacing) is injected,
 * so the full matrix of outcomes is deterministic-clock-testable with a fake
 * backend.
 *
 * Outcome mapping:
 *   - stream ends with `done`     -> completed
 *   - stream yields `cancelled`   -> cancelled
 *   - stream yields `error` (authentication) -> blocked-auth
 *   - stream yields `error` (transient)      -> failed (retryable)
 *   - stream yields `error` (permanent)      -> failed (not retryable)
 *   - no backend / provider not connected    -> blocked-auth
 *
 * SECRET INVARIANT: no key/token/credential crosses this path. Auth lives
 * behind the Rust boundary (native-API) or a provider-owned auth cache (Codex).
 */

import type {
  AgentRunRequest,
  BackendAgentEvent,
  BackendProvider,
  PermissionMode,
  ScheduledExecutionRoute
} from "@fable/protocol";
import type { AgentBackend } from "../agent-runtime";
import type { ToolExecutor } from "../native-api/agent-loop";

export type ScheduledExecutionResult =
  | { status: "completed"; transcript: string }
  | { status: "blocked-auth"; error: string; code: "authentication" }
  | { status: "cancelled"; error?: string }
  | { status: "failed"; error: string; code: string; retryable: boolean };

export interface ScheduledExecutionInput {
  runId: string;
  /** The resolved execution route (backend/model/permission). */
  route: ScheduledExecutionRoute | undefined;
  /** The provider the resolved backend runs for, or null when none is connected. */
  provider: BackendProvider | undefined;
  /** The live AgentBackend for the resolved provider, or null. */
  backend: AgentBackend | null;
  prompt: string;
  maxTokens: number;
  /** Executes an approved tool call (routed through Fable's approval gate). */
  execute: ToolExecutor;
  /** Cooperative cancellation hook, checked between events. */
  shouldCancel?: () => boolean;
  /** Surface a tool-call event (so the shell can register it for approval). */
  onToolCall?: (event: Extract<BackendAgentEvent, { type: "tool-call" }>) => void;
  /** Notifies the shell the backend transport is retrying (transient backoff). */
  onRetry?: () => void;
  /** The permission mode pinned to this run. */
  permissionMode?: PermissionMode;
}

function fail(error: string, code: string, retryable: boolean): ScheduledExecutionResult {
  return { status: "failed", error, code, retryable };
}

function errorMetadata(error: unknown): { message: string; code: string; retryable: boolean } {
  const candidate = error as { message?: string; code?: string; retryable?: boolean };
  return {
    message: candidate?.message ?? "Agent backend failed.",
    code: candidate?.code ?? "backend-failed",
    retryable: candidate?.retryable ?? false
  };
}

/**
 * Execute one scheduled prompt through the resolved `AgentBackend` route.
 *
 * Returns a `ScheduledExecutionResult` the caller reports back to the Rust
 * queue. Never throws — every failure path is mapped to a typed result so the
 * caller can always advance the queue entry.
 */
export async function executeScheduledPrompt(
  input: ScheduledExecutionInput
): Promise<ScheduledExecutionResult> {
  // No provider connected at all -> blocked-auth (auto-requeued on reconnect).
  if (!input.provider || input.provider.authState !== "connected") {
    return {
      status: "blocked-auth",
      error: "The scheduled backend is not connected.",
      code: "authentication"
    };
  }
  if (!input.backend || input.backend.providerId !== input.provider.id) {
    return fail(
      "The scheduled backend runtime is unavailable on this device.",
      "backend-unavailable",
      true
    );
  }
  const modelId =
    input.route?.policy === "pinned" && input.route.modelId
      ? input.route.modelId
      : input.provider.models.find((candidate) => candidate.available)?.id ?? input.route?.modelId;
  if (!modelId) {
    return fail("The scheduled model is unavailable.", "model-unavailable", false);
  }

  const request: AgentRunRequest = {
    model: modelId,
    messages: [{ role: "user", content: input.prompt }],
    tools: [],
    maxTokens: input.maxTokens
  };
  const stream = input.backend.run(request, {
    execute: input.execute,
    shouldCancel: input.shouldCancel,
    permissionMode: input.permissionMode ?? input.route?.permissionMode ?? "read-only",
    runId: input.runId,
    onRetry: input.onRetry
  });
  if (!stream) {
    return fail(
      "The local desktop runtime cannot reach this backend.",
      "backend-unavailable",
      true
    );
  }

  let transcript = "";
  try {
    for await (const event of stream) {
      switch (event.type) {
        case "text-delta":
          transcript += event.text;
          break;
        case "tool-call":
          input.onToolCall?.(event);
          break;
        case "usage":
          break;
        case "tool-result":
          break;
        case "cancelled":
          return { status: "cancelled" };
        case "error": {
          if (event.code === "authentication" || /auth|unauthor|401|credential/i.test(event.message)) {
            return {
              status: "blocked-auth",
              error: event.message,
              code: "authentication"
            };
          }
          return fail(
            event.message,
            event.code ?? "backend-failed",
            event.retryable ?? false
          );
        }
        case "done":
          return { status: "completed", transcript };
      }
    }
    // Stream ended without an explicit `done`: treat as completed.
    return { status: "completed", transcript };
  } catch (error) {
    const metadata = errorMetadata(error);
    if (metadata.code === "authentication") {
      return { status: "blocked-auth", error: metadata.message, code: "authentication" };
    }
    if (metadata.code === "cancelled") {
      return { status: "cancelled", error: metadata.message };
    }
    return fail(metadata.message, metadata.code, metadata.retryable);
  }
}

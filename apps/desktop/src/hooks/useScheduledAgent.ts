/**
 * The dedicated headless runner for scheduled prompts.
 *
 * Scheduled runs execute through `AgentBackend` exactly like interactive runs,
 * but in complete isolation: this hook owns its own backend resolution,
 * cancellation flag, approval routing, and lease-renewal heartbeat. It never
 * touches the composer or the active thread — fixing the bug where the previous
 * App.tsx hijacked `runPrompt` (reusing interactive agent state) for scheduled
 * work.
 *
 * Flow:
 *   1. The shell pushes a {@link PendingScheduledRun} onto `pendingWorkflowRuns`
 *      when the Rust tick emits a run-request event (or a missed occurrence is
 *      recovered on startup).
 *   2. This hook drains the queue one run at a time, resolving the backend from
 *      the run's frozen `execution` route + the current connection state.
 *   3. It runs `executeScheduledPrompt`, renewing the lease on a heartbeat so a
 *      long run is not re-queued by the five-second tick.
 *   4. The typed result is reported back via `onComplete`, which advances the
 *      Rust queue entry (done / dead / blocked-auth / cancelled).
 *
 * Approval + connector boundaries are preserved: tool calls route through the
 * shared approval gate (`options.execute`) exactly as the interactive path does.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { BackendProvider, ScheduledExecutionRoute } from "@fable/protocol";
import {
  resolveAgentBackend,
  executeScheduledPrompt,
  type AgentBackend,
  type BackendDeps,
  type ToolExecutor
} from "@fable/connectors";
import { createDesktopCodexAppServer } from "../lib/codex-app-server";
import { createDesktopTransport } from "../lib/native-transport";
import {
  listRuntimeBackendModels,
  renewRuntimeJobLease
} from "../runtime";

/** A scheduled run staged for headless execution. */
export interface PendingScheduledRun {
  runId: string;
  jobId: string;
  prompt: string;
  /** Fencing token from the lease; threaded through reports so stale calls are rejected. */
  leaseToken?: string;
  /** Frozen execution route (backend/model/permission). */
  execution?: ScheduledExecutionRoute;
}

export interface UseScheduledAgentOptions {
  /** All known backend providers (the route resolves against the connected one). */
  providers: BackendProvider[];
  /** The shared approval-gate-bound tool executor (same one the composer uses). */
  execute: ToolExecutor;
  /** Callback when a run finishes; the shell reports the outcome to the Rust queue. */
  onComplete: (
    runId: string,
    result:
      | { ok: true; transcript: string }
      | { ok: false; status: "failed" | "blocked-auth" | "cancelled"; error: string }
  ) => void;
}

/** Heartbeat interval for lease renewal (well under RUNNING_LEASE_MS = 15 min). */
const LEASE_RENEWAL_INTERVAL_MS = 60_000;

/**
 * Drain `pending` one run at a time through the headless execution path.
 */
export function useScheduledAgent(
  pending: PendingScheduledRun[],
  options: UseScheduledAgentOptions
): { active: PendingScheduledRun | null } {
  const deps: BackendDeps = useMemo(
    () => ({
      createTransport: createDesktopTransport,
      createCodexAppServer: createDesktopCodexAppServer,
      discoverModels: async (providerId) => listRuntimeBackendModels(providerId)
    }),
    []
  );

  // The connected provider (first connected + streaming + runnable). Mirrors the
  // shell's `connectedAgentBackend` derivation so route fallback is consistent.
  const connectedProvider = useMemo(
    () =>
      options.providers.find(
        (provider) =>
          provider.authState === "connected" &&
          provider.capabilities.includes("streaming")
      ),
    [options.providers]
  );

  const activeRef = useRef<PendingScheduledRun | null>(null);
  const cancelRef = useRef(false);

  const runOne = useCallback(
    async (run: PendingScheduledRun) => {
      // Resolve the backend for the run's route. For a pinned route we prefer
      // the pinned provider; resolveExecutionRoute lives in the pure layer, but
      // here we resolve the live AgentBackend the same way the factory does.
      const routeProvider =
        run.execution?.policy === "pinned" && run.execution.backendId
          ? options.providers.find((p) => p.id === run.execution!.backendId)
          : connectedProvider;
      const backend: AgentBackend | null = resolveAgentBackend(routeProvider, deps);

      // Lease-renewal heartbeat: keep the entry leased for the run's duration.
      let renewalTimer: ReturnType<typeof setInterval> | null = null;
      if (run.leaseToken) {
        renewalTimer = setInterval(() => {
          void renewRuntimeJobLease(run.runId, run.leaseToken!);
        }, LEASE_RENEWAL_INTERVAL_MS);
      }

      try {
        const result = await executeScheduledPrompt({
          runId: run.runId,
          route: run.execution,
          provider: routeProvider,
          backend,
          prompt: run.prompt,
          maxTokens: 1024,
          execute: options.execute,
          shouldCancel: () => cancelRef.current,
          onToolCall: () => {
            // Tool calls are executed via `options.execute` (the shared approval
            // gate); no extra wiring is needed here.
          }
        });

        if (result.status === "completed") {
          options.onComplete(run.runId, { ok: true, transcript: result.transcript });
        } else if (result.status === "blocked-auth") {
          options.onComplete(run.runId, {
            ok: false,
            status: "blocked-auth",
            error: result.error
          });
        } else if (result.status === "cancelled") {
          options.onComplete(run.runId, {
            ok: false,
            status: "cancelled",
            error: result.error ?? "Cancelled."
          });
        } else {
          options.onComplete(run.runId, { ok: false, status: "failed", error: result.error });
        }
      } finally {
        if (renewalTimer) clearInterval(renewalTimer);
      }
    },
    [connectedProvider, deps, options]
  );

  useEffect(() => {
    // Drain one run at a time so scheduled work never contends with itself.
    const next = pending[0];
    if (!next || activeRef.current) return;
    activeRef.current = next;
    cancelRef.current = false;
    void runOne(next).finally(() => {
      activeRef.current = null;
    });
  }, [pending, runOne]);

  // Cleanup on unmount: signal cancellation to any in-flight run.
  useEffect(() => {
    return () => {
      cancelRef.current = true;
    };
  }, []);

  return { active: activeRef.current };
}

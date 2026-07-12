/**
 * The dedicated headless runner for scheduled workflows.
 *
 * Prompt/agent tasks execute through `AgentBackend` exactly like interactive runs,
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
 *   3. It runs the persisted workflow, renewing the lease on a heartbeat so a
 *      long run is not re-queued by the five-second tick.
 *   4. The typed result is reported back via `onComplete`, which advances the
 *      Rust queue entry (done / dead / blocked-auth / cancelled).
 *
 * Approval + connector boundaries are preserved: tool calls route through the
 * shared approval gate (`options.execute`) exactly as the interactive path does.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import type {
  ApprovalRequest,
  BackendProvider,
  FirstWaveConnectorId,
  ScheduledExecutionRoute,
  WorkflowDefinition,
  WorkflowRun
} from "@fable/protocol";
import {
  resolveAgentBackend,
  executeScheduledPrompt,
  runWorkflow,
  type AgentBackend,
  type BackendDeps,
  type ToolExecutor
} from "@fable/connectors";
import { createDesktopCodexAppServer } from "../lib/codex-app-server";
import { createDesktopTransport } from "../lib/native-transport";
import { selectNativeProviderRoute } from "../lib/provider-route-selection";
import {
  cancelRuntimeCompletion,
  listenRuntimeSchedulerCancelRequest,
  listRuntimeBackendModels,
  renewRuntimeJobLease,
  saveRuntimeWorkflowRun,
  searchRuntimeConnector
} from "../runtime";

/** A scheduled run staged for headless execution. */
export interface PendingScheduledRun {
  runId: string;
  jobId: string;
  prompt: string;
  definition: WorkflowDefinition;
  previous?: WorkflowRun;
  /** Fencing token from the lease; threaded through reports so stale calls are rejected. */
  leaseToken?: string;
  attemptNumber?: number;
  /** Frozen execution route (backend/model/permission). */
  execution?: ScheduledExecutionRoute;
}

export interface UseScheduledAgentOptions {
  /** All known backend providers (the route resolves against the connected one). */
  providers: BackendProvider[];
  /** The shared approval-gate-bound tool executor (same one the composer uses). */
  execute: ToolExecutor;
  /** Connected connector ids used by workflow prerequisite checks. */
  connectedConnectorIds?: string[];
  /** Surface every model- or workflow-originated tool call for user approval. */
  onToolApproval: (event: {
    callId: string;
    tool: string;
    arguments: string;
    approval: ApprovalRequest;
  }) => void;
  /** Clear gate-backed approval cards when a scheduled run is cancelled. */
  onCancelApprovals: () => void;
  /** Callback when a run finishes; the shell reports the outcome to the Rust queue. */
  onComplete: (
    runId: string,
    result:
      | { ok: true; transcript: string }
      | { ok: false; status: "failed" | "blocked-auth" | "cancelled"; error: string },
    run: WorkflowRun
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
  const abortRef = useRef<AbortController | null>(null);
  // The options object is rebuilt on every App render (its callbacks and the
  // connectedConnectorIds array change identity frequently). Holding the latest
  // one in a ref lets `runOne` read current providers/connectors/execute/onComplete
  // without depending on the object's identity, so the drain effect does not
  // re-evaluate on every unrelated render. Mirrors the ref pattern already used
  // in useNativeAgent for the same unstable-options reason.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let dispose: (() => void) | null = null;
    void listenRuntimeSchedulerCancelRequest(({ runId }) => {
      if (activeRef.current?.runId === runId) {
        cancelRef.current = true;
        abortRef.current?.abort();
        void cancelRuntimeCompletion(runId);
        optionsRef.current.onCancelApprovals();
      }
    }).then((unlisten) => {
      dispose = unlisten;
    });
    return () => {
      void dispose?.();
    };
  }, []);

  const runOne = useCallback(
    async (run: PendingScheduledRun) => {
      // Resolve the backend for the run's route. For a pinned route we prefer
      // the pinned provider; resolveExecutionRoute lives in the pure layer, but
      // here we resolve the live AgentBackend the same way the factory does.
      const routeProvider =
        run.execution?.policy === "pinned" && run.execution.backendId
          ? optionsRef.current.providers.find((p) => p.id === run.execution!.backendId)
          : connectedProvider;
      const backend: AgentBackend | null = resolveAgentBackend(routeProvider, deps);
      const controller = new AbortController();
      abortRef.current = controller;

      // Lease-renewal heartbeat: keep the entry leased for the run's duration.
      let renewalTimer: ReturnType<typeof setInterval> | null = null;
      if (run.leaseToken) {
        renewalTimer = setInterval(() => {
          void renewRuntimeJobLease(run.runId, run.leaseToken!);
        }, LEASE_RENEWAL_INTERVAL_MS);
      }

      try {
        const executePrompt = async (prompt: string) => {
          const routeModel = run.execution?.policy === "pinned" && run.execution.modelId
            ? run.execution.modelId
            : routeProvider?.models.find((candidate) => candidate.available)?.id ?? run.execution?.modelId;
          const providerRoute = routeProvider?.backendType === "native-api"
            && routeProvider.authState === "connected" && backend && routeModel
            ? await selectNativeProviderRoute({
                providerId: routeProvider.id,
                model: routeModel,
                requiredInputTokens: Math.max(1, Math.ceil(prompt.length / 4)),
                requiredOutputTokens: 1024,
                requiresTools: false
              })
            : undefined;
          const result = await executeScheduledPrompt({
            runId: run.runId,
            route: run.execution,
            provider: routeProvider,
            backend,
            prompt,
            maxTokens: 1024,
            ...(providerRoute ? { providerRoute } : {}),
            execute: optionsRef.current.execute,
            shouldCancel: () => cancelRef.current,
            onToolCall: (event) => optionsRef.current.onToolApproval(event)
          });
          if (result.status === "completed") return result.transcript;
          if (result.status === "cancelled") {
            controller.abort();
            throw new DOMException(result.error ?? "Cancelled.", "AbortError");
          }
          throw Object.assign(new Error(result.error), {
            code: result.status === "blocked-auth" ? "authentication" : result.code
          });
        };

        const workflowRun = await runWorkflow(
          run.definition,
          {
            runId: run.runId,
            trigger: "schedule",
            scheduledJobId: run.jobId,
            permissionProfile: run.execution?.permissionProfile,
            attemptNumber: run.attemptNumber,
            previous: run.previous,
            signal: controller.signal
          },
          {
            now: () => new Date(),
            persist: async (value) => {
              await saveRuntimeWorkflowRun(value);
            },
            connected: (connectorId) =>
              optionsRef.current.connectedConnectorIds?.includes(connectorId) ?? false,
            prompt: (text) => executePrompt(text),
            agent: (step) => executePrompt(step.prompt),
            connectorRead: async (step) => {
              if (step.capability !== "search") {
                throw Object.assign(
                  new Error(`Connector capability "${step.capability}" is not available to scheduled workflows.`),
                  { code: "connector-capability-unavailable" }
                );
              }
              const result = await searchRuntimeConnector({
                connectorId: step.connectorId as FirstWaveConnectorId,
                query: String(step.input.query ?? ""),
                limit:
                  typeof step.input.limit === "number"
                    ? step.input.limit
                    : undefined
              });
              if (!result) {
                throw Object.assign(new Error("Connector reads require the desktop runtime."), {
                  code: "connector-runtime-unavailable"
                });
              }
              return result;
            },
            tool: async (step, _idempotencyKey) => {
              const requestedAt = new Date().toISOString();
              const approval: ApprovalRequest = {
                id: `workflow:${run.runId}:${step.id}`,
                service: "workflow",
                action: step.tool,
                mode: run.execution?.permissionMode ?? "read-only",
                permissionProfile: run.execution?.permissionProfile,
                riskLevel: step.consequential ? "high" : "low",
                dataUsed: Object.keys(step.arguments),
                consequence: `Execute workflow task ${step.id}.`,
                requestedAt,
                decisions: ["once", "modify", "deny"]
              };
              const serializedArguments = JSON.stringify(step.arguments);
              optionsRef.current.onToolApproval({
                callId: approval.id,
                tool: step.tool,
                arguments: serializedArguments,
                approval
              });
              return optionsRef.current.execute(approval, serializedArguments);
            }
          }
        );

        const transcript = workflowRun.steps
          .map((step) => (typeof step.output === "string" ? step.output : ""))
          .filter(Boolean)
          .join("\n");
        if (workflowRun.status === "completed") {
          optionsRef.current.onComplete(run.runId, { ok: true, transcript }, workflowRun);
        } else if (workflowRun.status === "blocked-auth") {
          optionsRef.current.onComplete(
            run.runId,
            {
              ok: false,
              status: "blocked-auth",
              error: workflowRun.failureReason ?? "Connector authentication is required."
            },
            workflowRun
          );
        } else if (workflowRun.status === "cancelled") {
          optionsRef.current.onComplete(
            run.runId,
            { ok: false, status: "cancelled", error: "Cancelled." },
            workflowRun
          );
        } else {
          optionsRef.current.onComplete(
            run.runId,
            {
              ok: false,
              status: "failed",
              error: workflowRun.failureReason ?? "Workflow failed."
            },
            workflowRun
          );
        }
      } finally {
        if (renewalTimer) clearInterval(renewalTimer);
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [connectedProvider, deps]
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
      abortRef.current?.abort();
    };
  }, []);

  return { active: activeRef.current };
}

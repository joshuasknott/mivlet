import type {
  ExecutionAttempt,
  ExecutionContextReceipt,
  ProviderRouteExecutionBinding,
} from "@mivlet/protocol";
import type { NativeAgentState } from "./types";

/** Merge listed or recovered journals into the visible receipts without starting work. */
export function mergeRecoveredAttempts(
  current: NativeAgentState,
  runs: ExecutionAttempt[],
): NativeAgentState {
  return {
    ...current,
    contextReceipts: runs.reduce<Record<string, ExecutionContextReceipt>>(
      (receipts, run) => {
        if (run.contextReceipt) receipts[run.id] = run.contextReceipt;
        return receipts;
      },
      { ...current.contextReceipts },
    ),
    providerRoutes: runs.reduce<Record<string, ProviderRouteExecutionBinding>>(
      (routes, run) => {
        if (run.providerRoute) routes[run.id] = run.providerRoute;
        return routes;
      },
      { ...current.providerRoutes },
    ),
    usageReceipts: runs.reduce<
      Record<string, NonNullable<ExecutionAttempt["usage"]>>
    >(
      (receipts, run) => {
        if (run.usage) receipts[run.id] = run.usage;
        return receipts;
      },
      { ...current.usageReceipts },
    ),
    recoverableAttempts: runs.filter(
      (run) =>
        (run.status === "interrupted" || run.status === "failed") &&
        run.recoverable,
    ),
    progressReceipts: Object.fromEntries(
      runs.map((run) => [
        run.id,
        {
          summaries: run.reasoningSummaries ?? {},
          startedAt: run.createdAt,
          endedAt: run.updatedAt,
        },
      ]),
    ),
  };
}

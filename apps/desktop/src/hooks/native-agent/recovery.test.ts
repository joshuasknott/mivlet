import type { ExecutionAttempt } from "@mivlet/protocol";
import { describe, expect, it } from "vitest";
import { mergeRecoveredAttempts } from "./recovery";
import { createInitialNativeAgentState } from "./runtime";

function attempt(
  patch: Partial<ExecutionAttempt> & Pick<ExecutionAttempt, "id" | "status">,
): ExecutionAttempt {
  return {
    providerId: "openai",
    model: "gpt-5",
    transcript: "",
    turn: 0,
    pendingApprovalIds: [],
    recoverable: patch.status !== "completed",
    retryCount: 0,
    createdAt: "2026-07-11T12:00:00.000Z",
    updatedAt: "2026-07-11T12:00:01.000Z",
    ...patch,
  };
}

describe("mergeRecoveredAttempts", () => {
  it("hydrates receipts, recoverable journals, and progress evidence", () => {
    const runs = [
      attempt({
        id: "attempt-completed",
        status: "completed",
        recoverable: false,
        contextReceipt: {
          version: 1,
          attemptId: "attempt-completed",
          assembledAt: "2026-07-11T12:00:00.000Z",
          scope: { level: "global" },
          citations: [],
          contributions: [{ id: "item-0", kind: "source", reason: "retrieved" }],
        },
        providerRoute: {
          workspaceId: "workspace-1" as never,
          selection: {
            providerRouteId: "route-completed" as never,
            selectedAt: "2026-07-12T12:00:00Z" as never,
            reason: "Selected route completed.",
          },
        },
        usage: { inputTokens: 40, outputTokens: 5, costUsd: 0, costUnknown: true },
        reasoningSummaries: { public: "Summary for completed" },
      }),
      attempt({
        id: "attempt-failed",
        status: "failed",
        recoverable: true,
        usage: { inputTokens: 41, outputTokens: 6, costUsd: 0, costUnknown: true },
      }),
      attempt({
        id: "attempt-interrupted",
        status: "interrupted",
        recoverable: true,
      }),
    ];
    const merged = mergeRecoveredAttempts(createInitialNativeAgentState(), runs);
    expect(Object.keys(merged.contextReceipts)).toEqual(["attempt-completed"]);
    expect(merged.providerRoutes["attempt-completed"]?.selection.reason).toBe(
      "Selected route completed.",
    );
    expect(merged.usageReceipts["attempt-failed"]).toMatchObject({
      inputTokens: 41,
      outputTokens: 6,
      costUnknown: true,
    });
    expect(merged.recoverableAttempts.map((run) => run.id)).toEqual([
      "attempt-failed",
      "attempt-interrupted",
    ]);
    expect(merged.progressReceipts?.["attempt-completed"].summaries).toEqual({
      public: "Summary for completed",
    });
  });
});

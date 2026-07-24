import { describe, expect, it } from "vitest";
import type { Spine } from "@fable/protocol";
import {
  decideWorkerContinuation,
  type WorkerIterationFact
} from "./continuation";

const worker = {
  id: "worker-1",
  budget: {
    maxDurationMs: 10_000,
    maxInputTokens: 1_000,
    maxOutputTokens: 500,
    maxToolCalls: 4,
    maxAttempts: 2
  },
  stopConditions: [
    {
      kind: "no-progress",
      description: "Stop after two iterations without useful progress.",
      threshold: 2
    }
  ]
} as unknown as Spine.Missions.Worker;

function fact(
  iterationNumber: number,
  overrides: Partial<WorkerIterationFact> = {}
): WorkerIterationFact {
  return {
    iterationNumber,
    attemptNumber: 1,
    elapsedMs: 100,
    inputTokens: 10,
    outputTokens: 10,
    toolCalls: 0,
    progressFingerprint: `progress-${iterationNumber}`,
    acceptanceStatus: "unevaluated",
    cancellationRequested: false,
    humanStopRequested: false,
    policyStopRequested: false,
    deadlineReached: false,
    ...overrides
  };
}

describe("bounded worker continuation", () => {
  it("continues within bounds and stops at the explicit iteration limit", () => {
    expect(decideWorkerContinuation({
      worker, history: [], current: fact(1), maxIterations: 2, allowEscalation: false
    })).toMatchObject({ action: "continue", nextIterationNumber: 2 });
    expect(decideWorkerContinuation({
      worker, history: [fact(1)], current: fact(2), maxIterations: 2,
      allowEscalation: false
    })).toMatchObject({ action: "stop", reason: "iteration-limit" });
  });

  it("never treats worker or external opinion as completion authority", () => {
    for (const acceptanceAuthority of ["worker", "external"] as const) {
      expect(() => decideWorkerContinuation({
        worker,
        history: [],
        current: fact(1, { acceptanceStatus: "accepted", acceptanceAuthority }),
        maxIterations: 2,
        allowEscalation: false
      })).toThrow("trusted policy or identified human");
    }
    expect(decideWorkerContinuation({
      worker,
      history: [],
      current: fact(1, { acceptanceStatus: "accepted", acceptanceAuthority: "policy" }),
      maxIterations: 2,
      allowEscalation: false
    })).toMatchObject({ action: "complete", reason: "accepted" });
  });

  it("stops deterministically for cancellation, human, policy, and budget", () => {
    const cases = [
      [{ cancellationRequested: true }, "cancelled"],
      [{ humanStopRequested: true }, "human-stop"],
      [{ policyStopRequested: true }, "policy-stop"],
      [{ outputTokens: 500 }, "budget"]
    ] as const;
    for (const [overrides, reason] of cases) {
      expect(decideWorkerContinuation({
        worker, history: [], current: fact(1, overrides), maxIterations: 4,
        allowEscalation: false
      })).toMatchObject({ action: "stop", reason });
    }
  });

  it("retries only a retained retryable failure within the saved attempt budget", () => {
    const error = {
      code: "provider-temporary",
      category: "provider",
      message: "Provider unavailable.",
      retryable: true
    } as Spine.Missions.ContractError;
    expect(decideWorkerContinuation({
      worker, history: [], current: fact(1, { retryableError: error }),
      maxIterations: 4, allowEscalation: false
    })).toMatchObject({
      action: "retry", nextAttemptNumber: 2, requiresFreshAuthorization: true
    });
    expect(decideWorkerContinuation({
      worker, history: [], current: fact(1, { attemptNumber: 2, retryableError: error }),
      maxIterations: 4, allowEscalation: true
    })).toMatchObject({
      action: "escalate", reason: "attempts-exhausted", requiresFreshAuthorization: true
    });
  });

  it("uses exact consecutive fingerprints for the no-progress stop", () => {
    expect(decideWorkerContinuation({
      worker,
      history: [fact(1, { progressFingerprint: "same" })],
      current: fact(2, { progressFingerprint: "same" }),
      maxIterations: 4,
      allowEscalation: false
    })).toMatchObject({ action: "stop", reason: "no-progress" });
  });

  it("rejects noncontiguous or ambiguous iteration facts", () => {
    expect(() => decideWorkerContinuation({
      worker, history: [fact(2)], current: fact(3), maxIterations: 4,
      allowEscalation: false
    })).toThrow("contiguous");
    expect(() => decideWorkerContinuation({
      worker,
      history: [],
      current: fact(1, {
        acceptanceStatus: "unevaluated",
        acceptanceAuthority: "worker"
      }),
      maxIterations: 4,
      allowEscalation: false
    })).toThrow("exact evaluation authority");
  });
});

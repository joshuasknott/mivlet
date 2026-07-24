import type { Spine } from "@fable/protocol";
import {
  evaluateMissionCoordination,
  type CoordinationWorkerState,
  type DeclaredStepJoin,
  type MissionCoordinationDecision,
  type MissionCoordinationGraph
} from "./coordination.js";

const MAX_GRAPH_TRANSITIONS = 256;

export interface DurableMissionGraphSnapshot {
  workerStates: Readonly<Record<string, CoordinationWorkerState>>;
  completedAggregationStepKeys: readonly string[];
  cancellationRequested: boolean;
}

export interface MissionGraphRunnerCallbacks {
  /** Reload only authenticated durable facts after every coordination boundary. */
  loadSnapshot(): Promise<DurableMissionGraphSnapshot>;
  /**
   * Resolve the exact predeclared join from durable dependency facts. The
   * callback must be replay-safe and cannot alter the declaration.
   */
  settleJoin(join: DeclaredStepJoin): Promise<"waiting" | "satisfied" | "blocked">;
  /**
   * Execute one already-assigned worker through its provider-neutral backend.
   * The promise must resolve only after a durable completed/failed/cancelled
   * worker fact exists.
   */
  executeWorker(worker: Spine.Missions.Worker, signal: AbortSignal): Promise<void>;
  /**
   * Record the graph's declared deterministic aggregation. The callback must
   * derive its manifest from durable worker outputs, never model prose.
   */
  recordAggregation(stepKey: string): Promise<void>;
  /** Persist one cooperative run cancellation before aborting worker egress. */
  requestCancellation(): Promise<void>;
}

export interface RunMissionGraphInput {
  graph: MissionCoordinationGraph;
  callbacks: MissionGraphRunnerCallbacks;
  signal?: AbortSignal;
}

export interface MissionGraphRunReceipt {
  status: "complete" | "waiting" | "blocked" | "cancelled";
  launchedWorkerIds: readonly Spine.Primitives.WorkerId[];
  settledJoinKeys: readonly string[];
  recordedAggregationStepKeys: readonly string[];
  finalDecision: MissionCoordinationDecision;
}

export class MissionGraphRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionGraphRunnerError";
  }
}

/**
 * Run a compiled Mission graph without owning provider, credential, grant, or
 * approval authority. The runner reacts only to reloaded durable state and
 * delegates every state-changing boundary to a replay-safe native callback.
 */
export async function runMissionGraph(input: RunMissionGraphInput): Promise<MissionGraphRunReceipt> {
  const launched = new Set<Spine.Primitives.WorkerId>();
  const settledJoins = new Set<string>();
  const recordedAggregations = new Set<string>();
  const inFlight = new Map<
    Spine.Primitives.WorkerId,
    Promise<{ workerId: Spine.Primitives.WorkerId; error?: unknown }>
  >();
  const cancellation = new AbortController();
  let cancellationPersisted = false;
  let lastDecision: MissionCoordinationDecision | undefined;
  let externalAbortRequested = input.signal?.aborted === true;
  let wakeForAbort: (() => void) | undefined;

  const relayAbort = () => {
    externalAbortRequested = true;
    wakeForAbort?.();
  };
  input.signal?.addEventListener("abort", relayAbort, { once: true });

  try {
    for (let transition = 0; transition < MAX_GRAPH_TRANSITIONS; transition += 1) {
      let snapshot = await input.callbacks.loadSnapshot();
      validateSnapshot(input.graph, snapshot);

      if (snapshot.cancellationRequested || externalAbortRequested) {
        if (!snapshot.cancellationRequested && !cancellationPersisted) {
          await input.callbacks.requestCancellation();
          cancellationPersisted = true;
          snapshot = await input.callbacks.loadSnapshot();
          validateSnapshot(input.graph, snapshot);
          if (!snapshot.cancellationRequested) {
            throw new MissionGraphRunnerError(
              "Mission cancellation was not durable before worker abort."
            );
          }
        }
        cancellation.abort(input.signal?.reason);
        if (inFlight.size > 0) {
          await Promise.allSettled(inFlight.values());
          inFlight.clear();
        }
        const finalDecision = evaluate(input.graph, await input.callbacks.loadSnapshot());
        return receipt("cancelled", launched, settledJoins, recordedAggregations, finalDecision);
      }

      lastDecision = evaluate(input.graph, snapshot);
      let changed = false;

      for (const stepKey of lastDecision.readyAggregationStepKeys) {
        const join = input.graph.joinByTargetStepKey.get(stepKey);
        if (join) {
          const result = await input.callbacks.settleJoin(join);
          if (result === "blocked") {
            const finalDecision = evaluate(input.graph, await input.callbacks.loadSnapshot());
            return receipt("blocked", launched, settledJoins, recordedAggregations, finalDecision);
          }
          if (result !== "satisfied") continue;
          settledJoins.add(join.joinKey);
        }
        await input.callbacks.recordAggregation(stepKey);
        recordedAggregations.add(stepKey);
        changed = true;
      }
      if (changed) continue;

      for (const workerId of lastDecision.readyWorkerIds) {
        if (inFlight.has(workerId) || launched.has(workerId)) continue;
        const worker = workerById(input.graph, workerId);
        const join = worker.planStepKey
          ? input.graph.joinByTargetStepKey.get(worker.planStepKey)
          : undefined;
        if (join) {
          const result = await input.callbacks.settleJoin(join);
          if (result === "blocked") {
            const finalDecision = evaluate(input.graph, await input.callbacks.loadSnapshot());
            return receipt("blocked", launched, settledJoins, recordedAggregations, finalDecision);
          }
          if (result !== "satisfied") continue;
          settledJoins.add(join.joinKey);
        }
        launched.add(workerId);
        const execution = Promise.resolve()
          .then(() => input.callbacks.executeWorker(worker, cancellation.signal))
          .then(
            () => ({ workerId }),
            (error: unknown) => ({ workerId, error })
          );
        inFlight.set(workerId, execution);
        changed = true;
      }

      if (inFlight.size > 0) {
        const abortWake = new Promise<{ aborted: true }>((resolve) => {
          wakeForAbort = () => resolve({ aborted: true });
        });
        const settled = await Promise.race([...inFlight.values(), abortWake]);
        wakeForAbort = undefined;
        if ("aborted" in settled) continue;
        inFlight.delete(settled.workerId);
        const after = await input.callbacks.loadSnapshot();
        validateSnapshot(input.graph, after);
        const durableState = after.workerStates[settled.workerId];
        if (!["completed", "failed", "cancelled"].includes(durableState)) {
          throw new MissionGraphRunnerError(
            settled.error
              ? "A worker execution failed without recording a durable terminal fact."
              : "A worker execution returned before recording a durable terminal fact."
          );
        }
        continue;
      }

      if (changed) continue;
      if (lastDecision.complete) {
        return receipt("complete", launched, settledJoins, recordedAggregations, lastDecision);
      }
      if (lastDecision.blocked.length > 0) {
        return receipt("blocked", launched, settledJoins, recordedAggregations, lastDecision);
      }
      return receipt("waiting", launched, settledJoins, recordedAggregations, lastDecision);
    }
  } finally {
    input.signal?.removeEventListener("abort", relayAbort);
  }

  throw new MissionGraphRunnerError(
    `Mission coordination exceeded ${MAX_GRAPH_TRANSITIONS} durable transitions.`
  );
}

function evaluate(
  graph: MissionCoordinationGraph,
  snapshot: DurableMissionGraphSnapshot
): MissionCoordinationDecision {
  validateSnapshot(graph, snapshot);
  return evaluateMissionCoordination({
    graph,
    workerStates: snapshot.workerStates,
    completedAggregationStepKeys: snapshot.completedAggregationStepKeys
  });
}

function validateSnapshot(
  graph: MissionCoordinationGraph,
  snapshot: DurableMissionGraphSnapshot
): void {
  const knownWorkerIds = new Set(
    [...graph.workerByStepKey.values()].map((worker) => worker.id)
  );
  const stateKeys = Object.keys(snapshot.workerStates);
  if (
    stateKeys.length !== knownWorkerIds.size ||
    stateKeys.some((workerId) => !knownWorkerIds.has(workerId as Spine.Primitives.WorkerId)) ||
    stateKeys.some((workerId) =>
      !["pending", "running", "completed", "failed", "cancelled"].includes(
        snapshot.workerStates[workerId]
      )
    )
  ) {
    throw new MissionGraphRunnerError(
      "Mission graph state must exactly match its compiled workers."
    );
  }
  const coordinateSteps = new Set(graph.aggregationByStepKey.keys());
  if (
    new Set(snapshot.completedAggregationStepKeys).size !==
      snapshot.completedAggregationStepKeys.length ||
    snapshot.completedAggregationStepKeys.some((stepKey) => !coordinateSteps.has(stepKey))
  ) {
    throw new MissionGraphRunnerError(
      "Mission graph aggregation state must match its declared coordinate steps."
    );
  }
}

function workerById(
  graph: MissionCoordinationGraph,
  workerId: Spine.Primitives.WorkerId
): Spine.Missions.Worker {
  const worker = [...graph.workerByStepKey.values()].find(
    (candidate) => candidate.id === workerId
  );
  if (!worker) {
    throw new MissionGraphRunnerError("A ready worker is not present in the compiled graph.");
  }
  return worker;
}

function receipt(
  status: MissionGraphRunReceipt["status"],
  launched: ReadonlySet<Spine.Primitives.WorkerId>,
  settledJoins: ReadonlySet<string>,
  recordedAggregations: ReadonlySet<string>,
  finalDecision: MissionCoordinationDecision
): MissionGraphRunReceipt {
  return {
    status,
    launchedWorkerIds: [...launched],
    settledJoinKeys: [...settledJoins],
    recordedAggregationStepKeys: [...recordedAggregations],
    finalDecision
  };
}

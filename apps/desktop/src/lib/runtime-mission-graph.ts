import {
  compileMissionCoordination,
  runMissionGraph,
  type CoordinationWorkerState,
  type DeclaredAggregation,
  type DeclaredStepJoin,
  type DurableMissionGraphSnapshot,
  type MissionCoordinationGraph,
  type MissionGraphRunReceipt
} from "@fable/connectors";
import type { Spine } from "@fable/protocol";
import {
  advanceRuntimeMissionCoordination,
  getRuntimeMissionPlan,
  getRuntimeMissionRun,
  requestRuntimeMissionRunCancellation
} from "../runtime";

type MissionPlanLifecycle = {
  mission: Spine.Missions.Mission;
  currentRevision: Spine.Missions.PlanRevision;
};

type MissionJournal = {
  run: Spine.Missions.Run;
  events: Array<Record<string, unknown>>;
};

type RuntimeGraphState = {
  graph: MissionCoordinationGraph;
  snapshot: DurableMissionGraphSnapshot;
  joinsByKey: ReadonlyMap<string, DeclaredStepJoin & {
    status: "open" | "satisfied" | "blocked" | "timed-out" | "cancelled";
  }>;
  journal: MissionJournal;
};

export interface ExecuteRuntimeMissionGraphInput {
  runId: string;
  executeWorker(
    worker: Spine.Missions.Worker,
    signal: AbortSignal
  ): Promise<void>;
  signal?: AbortSignal;
}

/**
 * Compose the provider-neutral graph runner with authenticated desktop facts.
 *
 * Provider execution remains an injected boundary. This adapter chooses no
 * provider, credential, capability grant, approval, placement, or evaluator.
 */
export async function executeRuntimeMissionGraph(
  input: ExecuteRuntimeMissionGraphInput
): Promise<MissionGraphRunReceipt | null> {
  const initial = await loadRuntimeGraphState(input.runId);
  if (!initial) return null;
  return runMissionGraph({
    graph: initial.graph,
    signal: input.signal,
    callbacks: {
      loadSnapshot: async () => requireState(input.runId).then((state) => state.snapshot),
      settleJoin: async (join) => {
        await requireAdvance(input.runId);
        const state = await requireState(input.runId);
        const current = state.joinsByKey.get(join.joinKey);
        if (!current || !sameJoin(current, join)) {
          throw new Error("The native Mission join no longer matches the selected graph.");
        }
        if (current.status === "open") return "waiting";
        return current.status === "satisfied" ? "satisfied" : "blocked";
      },
      executeWorker: input.executeWorker,
      recordAggregation: async (stepKey) => {
        await requireAdvance(input.runId);
        const state = await requireState(input.runId);
        if (!state.snapshot.completedAggregationStepKeys.includes(stepKey)) {
          throw new Error("The native Mission aggregation did not become durable.");
        }
      },
      requestCancellation: async () => {
        const state = await requireState(input.runId);
        const { revision, lastSequence } = runHead(state.journal);
        await requestRuntimeMissionRunCancellation({
          runId: input.runId,
          eventId: `mission-runtime-stop-${crypto.randomUUID()}`,
          requestKey: `mission-runtime-stop:${crypto.randomUUID()}`,
          expectedRunRevision: revision,
          expectedLastSequence: lastSequence,
          mode: "cooperative",
          reason: "User requested stop."
        });
      }
    }
  });
}

async function requireAdvance(runId: string): Promise<void> {
  const result = await advanceRuntimeMissionCoordination(runId);
  if (!result) {
    throw new Error("Mission coordination is available only in the desktop app.");
  }
}

async function requireState(runId: string): Promise<RuntimeGraphState> {
  const state = await loadRuntimeGraphState(runId);
  if (!state) {
    throw new Error("Mission coordination is available only in the desktop app.");
  }
  return state;
}

async function loadRuntimeGraphState(runId: string): Promise<RuntimeGraphState | null> {
  const rawJournal = await getRuntimeMissionRun(runId);
  if (!rawJournal) return null;
  const journal = missionJournal(rawJournal);
  if (journal.run.id !== runId || journal.run.initiator.kind !== "mission") {
    throw new Error("The runtime Mission journal does not match the requested run.");
  }
  const rawLifecycle = await getRuntimeMissionPlan(journal.run.initiator.missionId);
  if (!rawLifecycle) {
    throw new Error("The selected Mission plan is unavailable.");
  }
  const lifecycle = missionLifecycle(rawLifecycle);
  const workers = exactWorkers(journal);
  const joinsByKey = exactJoins(lifecycle.currentRevision, workers, journal);
  const joins = [...joinsByKey.values()].map(({ status: _status, ...join }) => join);
  const aggregations = lifecycle.currentRevision.steps
    .filter((step) => step.kind === "coordinate")
    .map<DeclaredAggregation>((step) => ({
      stepKey: step.key,
      sourceStepKeys: [...step.dependsOnStepKeys],
      strategy: "ordered-manifest-v1"
    }));
  const graph = compileMissionCoordination({
    mission: lifecycle.mission,
    planRevision: lifecycle.currentRevision,
    workers,
    joins,
    aggregations
  });
  return {
    graph,
    snapshot: durableSnapshot(graph, journal),
    joinsByKey,
    journal
  };
}

function missionLifecycle(value: Record<string, unknown>): MissionPlanLifecycle {
  const mission = record(value.mission, "Mission");
  const revision = record(value.currentRevision, "Mission plan revision");
  if (
    typeof mission.id !== "string"
    || typeof revision.id !== "string"
    || !Array.isArray(revision.steps)
  ) {
    throw new Error("The selected Mission plan is invalid.");
  }
  return {
    mission: mission as unknown as Spine.Missions.Mission,
    currentRevision: revision as unknown as Spine.Missions.PlanRevision
  };
}

function missionJournal(value: Record<string, unknown>): MissionJournal {
  const run = record(value.run, "Mission run");
  if (typeof run.id !== "string" || !Array.isArray(value.events)) {
    throw new Error("The runtime Mission journal is invalid.");
  }
  return {
    run: run as unknown as Spine.Missions.Run,
    events: value.events.map((event) => record(event, "Mission event"))
  };
}

function exactWorkers(journal: MissionJournal): Spine.Missions.Worker[] {
  const workers = journal.events
    .filter((event) => event.type === "worker-created")
    .map((event) => record(record(event.payload, "Worker event payload").worker, "Mission worker"))
    .map((worker) => worker as unknown as Spine.Missions.Worker);
  if (workers.length === 0) {
    throw new Error("The selected Mission has no durable worker assignments.");
  }
  return workers;
}

function exactJoins(
  revision: Spine.Missions.PlanRevision,
  workers: readonly Spine.Missions.Worker[],
  journal: MissionJournal
): ReadonlyMap<string, DeclaredStepJoin & {
  status: "open" | "satisfied" | "blocked" | "timed-out" | "cancelled";
}> {
  const steps = new Map(revision.steps.map((step) => [step.key, step]));
  const workerByStep = new Map(workers.map((worker) => [worker.planStepKey, worker.id]));
  const joins = new Map<string, DeclaredStepJoin & {
    status: "open" | "satisfied" | "blocked" | "timed-out" | "cancelled";
  }>();
  for (const event of journal.events) {
    if (event.type !== "join-opened" && event.type !== "join-resolved") continue;
    const join = record(record(event.payload, "Mission join payload").join, "Mission join");
    const joinKey = text(join.joinKey, "Mission join identity");
    const workerIds = strings(join.workerIds, "Mission join worker");
    const current = joins.get(joinKey);
    const matchingSteps = event.type === "join-opened"
      ? revision.steps.filter((step) =>
          step.dependsOnStepKeys.length >= 2
          && step.dependsOnStepKeys.length === workerIds.length
          && step.dependsOnStepKeys.every(
            (dependency, index) => workerByStep.get(dependency) === workerIds[index]
          ))
      : [];
    const storedTargetStepKey = join.targetStepKey === undefined
      ? undefined
      : text(join.targetStepKey, "Mission join target");
    const targetStepKey = current?.targetStepKey
      ?? storedTargetStepKey
      ?? (matchingSteps.length === 1 ? matchingSteps[0]!.key : undefined);
    const step = targetStepKey ? steps.get(targetStepKey) : undefined;
    const strategy = join.strategy;
    const status = join.status;
    if (!targetStepKey || !step) {
      throw new Error("The stored Mission join is invalid.");
    }
    if (
      storedTargetStepKey !== undefined
      && storedTargetStepKey !== targetStepKey
    ) {
      throw new Error("The stored Mission join changed its target.");
    }
    if (
      step.dependsOnStepKeys.length !== workerIds.length
      || step.dependsOnStepKeys.some(
        (dependency, index) => workerByStep.get(dependency) !== workerIds[index]
      )
      || !["all", "any", "quorum"].includes(String(strategy))
      || !["open", "satisfied", "blocked", "timed-out", "cancelled"].includes(String(status))
    ) {
      throw new Error("The stored Mission join is invalid.");
    }
    const declaration = {
      joinKey,
      targetStepKey,
      sourceStepKeys: [...step.dependsOnStepKeys],
      strategy: strategy as Spine.Missions.JoinStrategy,
      ...(strategy === "quorum" ? { quorum: integer(join.quorum, "Mission join quorum") } : {}),
      allowFailedWorkers: boolean(join.allowFailedWorkers, "Mission join failure policy"),
      ...(typeof join.deadline === "string" ? { deadline: join.deadline } : {}),
      status: status as "open" | "satisfied" | "blocked" | "timed-out" | "cancelled"
    };
    if (event.type === "join-opened") {
      if (current) throw new Error("The stored Mission join declaration is ambiguous.");
      joins.set(joinKey, declaration);
    } else {
      if (!current || !sameJoin(current, declaration) || current.status !== "open") {
        throw new Error("The stored Mission join resolution changed its declaration.");
      }
      joins.set(joinKey, declaration);
    }
  }
  return joins;
}

function durableSnapshot(
  graph: MissionCoordinationGraph,
  journal: MissionJournal
): DurableMissionGraphSnapshot {
  const workerStates: Record<string, CoordinationWorkerState> = {};
  const waitWorkers = new Map<string, string>();
  for (const worker of graph.workerByStepKey.values()) {
    workerStates[worker.id] = "pending";
  }
  for (const event of journal.events) {
    const payload = record(event.payload, "Mission event payload");
    if (event.type === "worker-started") {
      setWorkerState(workerStates, payload.workerId, "running", ["pending"]);
    } else if (event.type === "worker-completed") {
      setWorkerState(workerStates, payload.workerId, "completed", ["running"]);
    } else if (event.type === "worker-failed") {
      setWorkerState(workerStates, payload.workerId, "failed", ["running"]);
    } else if (event.type === "approval-requested" || event.type === "human-input-requested") {
      const wait = record(payload.wait, "Mission wait");
      if (typeof wait.workerId === "string") {
        const waitKey = text(wait.waitKey, "Mission wait identity");
        setWorkerState(workerStates, wait.workerId, "waiting", ["running"]);
        waitWorkers.set(waitKey, wait.workerId);
      }
    } else if (event.type === "approval-resolved" || event.type === "human-input-received") {
      const resolution = record(payload.resolution, "Mission wait resolution");
      const workerId = waitWorkers.get(text(resolution.waitKey, "Mission wait identity"));
      if (workerId && workerStates[workerId] === "waiting") {
        workerStates[workerId] = "running";
      }
    }
  }
  const completedAggregationStepKeys = journal.events
    .filter((event) => event.type === "aggregation-recorded")
    .map((event) =>
      text(
        record(record(event.payload, "Mission aggregation payload").aggregation, "Mission aggregation").stepKey,
        "Mission aggregation step"
      )
    );
  return {
    workerStates,
    completedAggregationStepKeys,
    cancellationRequested: ["cancelling", "cancelled"].includes(journal.run.status)
  };
}

function setWorkerState(
  states: Record<string, CoordinationWorkerState>,
  workerId: unknown,
  state: CoordinationWorkerState,
  allowedCurrent: readonly CoordinationWorkerState[]
): void {
  const id = text(workerId, "Mission worker identity");
  if (!(id in states)) throw new Error("Mission activity references an unknown worker.");
  const current = states[id];
  if (!allowedCurrent.includes(current)) {
    throw new Error("Mission worker activity is out of sequence.");
  }
  states[id] = state;
}

function sameJoin(
  left: DeclaredStepJoin,
  right: DeclaredStepJoin
): boolean {
  return left.joinKey === right.joinKey
    && left.targetStepKey === right.targetStepKey
    && left.strategy === right.strategy
    && left.quorum === right.quorum
    && left.allowFailedWorkers === right.allowFailedWorkers
    && left.deadline === right.deadline
    && left.sourceStepKeys.length === right.sourceStepKeys.length
    && left.sourceStepKeys.every((key, index) => right.sourceStepKeys[index] === key);
}

function runHead(journal: MissionJournal): { revision: number; lastSequence: number } {
  const head = record(journal.run.eventHead, "Mission run event head");
  return {
    revision: integer(journal.run.revision, "Mission run revision"),
    lastSequence: integer(head.lastSequence, "Mission run sequence")
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > 512
    || [...value].some((character) => character < " ")
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} is invalid.`);
  }
  return Number(value);
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error(`${label} identities are invalid.`);
  }
  const result = value.map((item) => text(item, label));
  if (new Set(result).size !== result.length) {
    throw new Error(`${label} identities are ambiguous.`);
  }
  return result;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid.`);
  return value;
}

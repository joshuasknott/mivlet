import type { AgentBackend } from "@fable/connectors";
import { catalogueCapabilities, executeLocalWorker, selectMissionProviderRoute } from "@fable/connectors";
import { type Spine } from "@fable/protocol";
import {
  createRuntimeMissionPlan,
  createRuntimeMissionRun,
  createRuntimeMissionWorker,
  finalizeRuntimeParallelApproaches,
  getRuntimeMissionRun,
  listRuntimeNativeProviderRoutes,
  openRuntimeParallelApproachesJoin,
  requestRuntimeMissionRunCancellation,
  startRuntimeMissionWorker,
  type RuntimeParallelApproachesResult
} from "../runtime";

export interface ParallelApproachesMissionInput {
  prompt: string;
  workspaceId: string;
  sourceThreadId: string;
  projectId?: string;
  backend: AgentBackend;
  model: string;
  createId?: (prefix: string) => string;
  onCancellationReady?: (cancel: () => Promise<void>) => void;
  onPlanReady?: (plan: ParallelApproachesPlanSummary) => void;
}

export interface ParallelApproachesPlanSummary {
  title: string;
  summary: string;
  executionLabel: string;
  steps: Array<{ title: string; objective: string; output: string }>;
  acceptance: string[];
  budget: { maxWorkers: number; maxDurationMs: number; maxOutputTokens: number; maxAttempts: number };
}

export interface ParallelApproachesMissionResult extends RuntimeParallelApproachesResult {
  plan: ParallelApproachesPlanSummary;
}

export function isParallelApproachesMissionPrompt(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return /\b(generate|create|develop|propose|give me)\b/.test(normalized)
    && /\btwo (independent |different |alternative )?approaches\b/.test(normalized)
    && /\b(compare|comparison|trade-?offs?)\b/.test(normalized);
}

export function isParallelApproachesPlanSummary(value: unknown): value is ParallelApproachesPlanSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  if (!Object.keys(plan).every((key) => ["title", "summary", "executionLabel", "steps", "acceptance", "budget"].includes(key))
    || !["title", "summary", "executionLabel"].every((key) => typeof plan[key] === "string" && Boolean((plan[key] as string).trim()))
    || !Array.isArray(plan.steps) || plan.steps.length !== 3
    || plan.steps.some((step) => !step || typeof step !== "object" || Array.isArray(step)
      || !["title", "objective", "output"].every((key) => typeof (step as Record<string, unknown>)[key] === "string" && Boolean(((step as Record<string, unknown>)[key] as string).trim())))
    || !Array.isArray(plan.acceptance) || plan.acceptance.length !== 1
    || plan.acceptance.some((criterion) => typeof criterion !== "string" || !criterion.trim())) return false;
  const budget = plan.budget as Record<string, unknown> | undefined;
  return Boolean(budget) && !Array.isArray(budget)
    && ["maxWorkers", "maxDurationMs", "maxOutputTokens", "maxAttempts"]
      .every((key) => Number.isInteger(budget![key]) && (budget![key] as number) > 0);
}

export async function executeParallelApproachesMission(
  input: ParallelApproachesMissionInput
): Promise<ParallelApproachesMissionResult> {
  if (input.backend.providerId !== "openai") {
    throw new Error("Parallel approach missions currently require the connected OpenAI API provider.");
  }
  const topic = input.prompt.trim();
  if (!topic || topic.length > 2_000) throw new Error("Parallel approach missions need a concise request.");
  const id = input.createId ?? secureId;
  const missionId = id("mission");
  const planId = id("plan");
  const planRevisionId = id("plan-revision");
  const runId = id("mission-run");
  const workerAId = id("worker");
  const workerBId = id("worker");
  const objectiveA = `Develop a practical, low-complexity approach for this request. Make assumptions and material uncertainty explicit: ${topic}`;
  const objectiveB = `Develop a meaningfully different, higher-upside approach for this request. Make assumptions, trade-offs, and material uncertainty explicit: ${topic}`;

  const plan: ParallelApproachesPlanSummary = {
    title: "Compare two approaches",
    summary: "Two independent workers develop distinct approaches; Fable joins their immutable outputs in a fixed order.",
    executionLabel: "Two workers · deterministic join",
    steps: [
      { title: "Practical approach", objective: objectiveA, output: "Required Markdown approach" },
      { title: "Alternative approach", objective: objectiveB, output: "Required Markdown approach" },
      { title: "Compare", objective: "Join both exact outputs without asking another model to reinterpret them.", output: "Draft comparison artifact" }
    ],
    acceptance: ["Both independently generated outputs must reach the durable all-workers join."],
    budget: { maxWorkers: 2, maxDurationMs: 90_000, maxOutputTokens: 2_048, maxAttempts: 1 }
  };
  input.onPlanReady?.(plan);

  const lifecycle = await createRuntimeMissionPlan({
    missionId,
    planId,
    planRevisionId,
    executionDepth: "multi-worker",
    outcome: {
      title: "Two approaches comparison",
      desiredOutcome: `Produce two independent approaches and compare them for: ${topic}`,
      deliverables: [{ key: "comparison", description: "A deterministic Markdown comparison of both approaches.", required: true }]
    },
    missionScope: {
      workspaceId: input.workspaceId,
      sourceThreadId: input.sourceThreadId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      departmentIds: [],
      context: []
    },
    constraints: [{
      key: "native:parallel-approaches:v1",
      description: "Use exactly two independent evidence-free workers and the fixed native deterministic join.",
      severity: "required",
      source: "orchestrator"
    }],
    acceptance: {
      requiresHumanAcceptance: false,
      minimumRequiredCriteria: 1,
      criteria: [{
        key: "both-approaches",
        description: "Both independently generated outputs reach the exact durable join.",
        required: true,
        evaluator: "policy"
      }]
    },
    budget: {
      maxDurationMs: 180_000,
      maxInputTokens: 32_000,
      maxOutputTokens: 4_096,
      maxToolCalls: 1,
      maxWorkers: 2,
      maxAttempts: 1
    },
    summary: topic,
    bounds: { maxSteps: 3, maxDependenciesPerStep: 2, maxParallelSteps: 2, maxRevisions: 1 },
    steps: [
      workerStep("approach-a", "Practical approach", objectiveA, "approach-a"),
      workerStep("approach-b", "Alternative approach", objectiveB, "approach-b"),
      {
        key: "compare",
        kind: "synthesize",
        title: "Compare approaches",
        objective: "Join both exact worker outputs into a stable comparison artifact.",
        dependsOnStepKeys: ["approach-a", "approach-b"],
        requiredCapabilities: [],
        expectedOutputs: [{ key: "comparison", description: "A deterministic Markdown comparison of both approaches.", required: true, format: "text/markdown" }],
        acceptanceCriterionKeys: ["both-approaches"],
        optional: false,
        estimatedBudget: { maxDurationMs: 5_000, maxInputTokens: 1, maxOutputTokens: 1, maxToolCalls: 1, maxAttempts: 1 }
      }
    ]
  });
  if (!lifecycle) throw new Error("Parallel mission planning requires the desktop runtime.");

  let journal = requireJournal(await createRuntimeMissionRun({
    missionId, runId, eventId: id("event"), idempotencyKey: id("run-create")
  }));
  journal = requireJournal(await createRuntimeMissionWorker({
    runId, eventId: id("event"), idempotencyKey: id("worker-create"), ...head(journal),
    workerId: workerAId, stepKey: "approach-a", context: [], grants: []
  }));
  const workerA = findWorker(journal, workerAId);
  journal = requireJournal(await createRuntimeMissionWorker({
    runId, eventId: id("event"), idempotencyKey: id("worker-create"), ...head(journal),
    workerId: workerBId, stepKey: "approach-b", context: [], grants: []
  }));
  const workerB = findWorker(journal, workerBId);

  const routes = await listRuntimeNativeProviderRoutes();
  if (!routes) throw new Error("Parallel mission routing requires the desktop runtime.");
  const pinned = routes.find((route) => route.providerFamily === input.backend.providerId
    && route.modelOrRuntimeReference === input.model
    && route.workspaceId === input.workspaceId);
  const capabilities = catalogueCapabilities(input.backend.providerId, input.model);
  if (!pinned || !capabilities) throw new Error("The selected model has no authorized parallel mission route.");
  const selection = selectMissionProviderRoute({
    workspaceId: input.workspaceId,
    capabilityId: "model.generate",
    requiredInputTokens: 16_000,
    requiredOutputTokens: 2_048,
    requiresTools: false,
    allowedPlacementKinds: ["local-desktop"],
    boundaries: pinned.boundaries,
    allowDegraded: false,
    maximumRisk: "medium",
    selectedAt: new Date().toISOString(),
    preference: { policy: "require", providerRouteIds: [pinned.id], allowFallback: false }
  }, routes.map((route) => ({
    route,
    capabilityIds: ["model.generate"],
    supportsTools: catalogueCapabilities(route.providerFamily, route.modelOrRuntimeReference)?.tools === true,
    contextWindowTokens: catalogueCapabilities(route.providerFamily, route.modelOrRuntimeReference)?.contextWindow ?? 0,
    ...(route.observationSummary ? { estimatedLatencyMs: route.observationSummary.medianLatencyMs, observation: route.observationSummary } : {}),
    ...(route.pricingSummary ? { pricing: route.pricingSummary } : {}),
    risk: "medium" as const
  }))).selection;

  journal = requireJournal(await startRuntimeMissionWorker({
    runId, workerId: workerAId, runStartEventId: id("event"), workerStartedEventId: id("event"),
    routeSelectedEventId: id("event"), providerId: input.backend.providerId,
    modelReference: input.model, routeSelection: selection, idempotencyKey: id("worker-start"), ...head(journal)
  }));
  const workerAStart = workerStartBinding(journal, workerAId);
  journal = requireJournal(await startRuntimeMissionWorker({
    runId, workerId: workerBId, workerStartedEventId: id("event"), routeSelectedEventId: id("event"),
    providerId: input.backend.providerId, modelReference: input.model,
    routeSelection: selection, idempotencyKey: id("worker-start"), ...head(journal)
  }));
  const workerBStart = workerStartBinding(journal, workerBId);
  journal = requireJournal(await openRuntimeParallelApproachesJoin({ runId, ...head(journal) }));
  const executionHead = head(journal);

  const cancellation = new AbortController();
  let cancellationPromise: Promise<void> | undefined;
  input.onCancellationReady?.(() => {
    cancellationPromise ??= (async () => {
      cancellation.abort();
      const providerCancellation = input.backend.cancel(runId);
      const eventId = id("event");
      const requestKey = id("stop");
      let durableError: unknown;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const current = requireJournal(await getRuntimeMissionRun(runId));
          const status = (current.run as Record<string, unknown>).status;
          if (["cancelling", "cancelled", "completed", "partially-completed", "failed"].includes(String(status))) {
            durableError = undefined;
            break;
          }
          await requestRuntimeMissionRunCancellation({
            runId, eventId, requestKey, ...head(current),
            mode: "cooperative", reason: "User requested stop."
          });
          durableError = undefined;
          break;
        } catch (error) {
          durableError = error;
        }
      }
      const providerResult = await Promise.allSettled([providerCancellation]);
      if (durableError) throw durableError;
      if (providerResult[0].status === "rejected") throw providerResult[0].reason;
    })();
    return cancellationPromise;
  });

  const execute = (worker: Spine.Missions.Worker, start: WorkerStartBinding) => executeLocalWorker({
    worker,
    backend: input.backend,
    model: input.model,
    prompt: worker.role.objective,
    toolSpecs: [],
    execute: async () => { throw new Error("Parallel approach workers cannot call tools."); },
    signal: cancellation.signal,
    missionWorkerExecution: {
      runId,
      workerId: worker.id,
      workerStartedEventId: start.workerStartedEventId,
      routeSelectedEventId: start.routeSelectedEventId,
      usageEventId: id("event"),
      completionEventId: id("event"),
      evaluationEventId: id("event"),
      resultEventId: id("event"),
      failureEventId: id("event"),
      idempotencyKey: id("worker-terminal"),
      ...executionHead
    }
  });
  const settled = await Promise.allSettled([execute(workerA, workerAStart), execute(workerB, workerBStart)]);
  if (cancellation.signal.aborted) {
    await cancellationPromise;
    throw new Error("The parallel approaches mission was cancelled.");
  }
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  try {
    const result = await finalizeRuntimeParallelApproaches(runId);
    if (!result) throw new Error("Parallel mission settlement requires the desktop runtime.");
    return { ...result, plan };
  } catch (error) {
    if (rejected) throw rejected.reason;
    throw error;
  }
}

function workerStep(key: string, title: string, objective: string, outputKey: string) {
  return {
    key,
    kind: "produce",
    title,
    objective,
    dependsOnStepKeys: [],
    requiredCapabilities: [],
    expectedOutputs: [{ key: outputKey, description: `A distinct Markdown ${title.toLowerCase()}.`, required: true, format: "text/markdown" }],
    acceptanceCriterionKeys: [],
    optional: false,
    estimatedBudget: { maxDurationMs: 90_000, maxInputTokens: 16_000, maxOutputTokens: 2_048, maxToolCalls: 1, maxAttempts: 1 }
  };
}

interface WorkerStartBinding { workerStartedEventId: string; routeSelectedEventId: string }

function workerStartBinding(journal: Record<string, unknown>, workerId: string): WorkerStartBinding {
  const events = journal.events as Array<Record<string, unknown>>;
  const started = events.find((event) => event.type === "worker-started"
    && (event.payload as Record<string, unknown>)?.workerId === workerId);
  const routed = events.find((event) => event.type === "route-selected"
    && (event.payload as Record<string, unknown>)?.workerId === workerId);
  if (typeof started?.id !== "string" || typeof routed?.id !== "string") {
    throw new Error("Parallel worker start evidence is unavailable.");
  }
  return { workerStartedEventId: started.id, routeSelectedEventId: routed.id };
}

function findWorker(journal: Record<string, unknown>, workerId: string): Spine.Missions.Worker {
  const event = (journal.events as Array<Record<string, unknown>>).find((candidate) =>
    candidate.type === "worker-created"
    && ((candidate.payload as Record<string, unknown>)?.worker as Record<string, unknown>)?.id === workerId
  );
  const worker = (event?.payload as Record<string, unknown> | undefined)?.worker;
  if (!worker || typeof worker !== "object") throw new Error("Parallel worker assignment is unavailable.");
  return worker as Spine.Missions.Worker;
}

function requireJournal(value: Record<string, unknown> | null): Record<string, unknown> {
  if (!value || typeof value.run !== "object" || !Array.isArray(value.events)) {
    throw new Error("Parallel mission journal is unavailable.");
  }
  return value;
}

function head(journal: Record<string, unknown>) {
  const run = journal.run as Record<string, unknown>;
  const eventHead = run.eventHead as Record<string, unknown> | undefined;
  if (!Number.isInteger(run.revision) || !Number.isInteger(eventHead?.lastSequence)) {
    throw new Error("Parallel mission event head is invalid.");
  }
  return { expectedRunRevision: run.revision as number, expectedLastSequence: eventHead!.lastSequence as number };
}

function secureId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `${prefix}-${random}`;
  const bytes = new Uint32Array(4);
  globalThis.crypto?.getRandomValues?.(bytes);
  return `${prefix}-${Array.from(bytes, (value) => value.toString(16).padStart(8, "0")).join("")}`;
}

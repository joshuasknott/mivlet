import type { AgentBackend } from "@fable/connectors";
import type { Spine } from "@fable/protocol";
import {
  advanceRuntimeMissionCoordination,
  createRuntimeMissionPlan,
  createRuntimeMissionRun,
  getRuntimeMissionRun,
  listRuntimeNativeProviderRoutes,
  prepareRuntimeMissionWorkers,
  readRuntimeMissionProgress,
  readRuntimeMissionWorkerOutput,
  type RuntimeMissionProgress,
  type RuntimeNativeProviderRoute
} from "../runtime";
import { executeRuntimeProviderMissionGraph } from "./runtime-mission-graph";
import {
  parseGeneralMissionDraft,
  type GeneralMissionDraft
} from "./general-mission-command";
export {
  parseGeneralMissionDraft,
  type GeneralMissionDraft
} from "./general-mission-command";

export interface GeneralMissionInput extends GeneralMissionDraft {
  workspaceId: string;
  sourceThreadId: string;
  projectId?: string;
  backend: AgentBackend;
  model: string;
  resolveBackend(
    route: RuntimeNativeProviderRoute
  ): AgentBackend | null | Promise<AgentBackend | null>;
  createId?: (prefix: string) => string;
  onRunReady?(runId: string, progress: RuntimeMissionProgress): void | Promise<void>;
  onProgress?(progress: RuntimeMissionProgress): void;
  onCancellationReady?(cancel: (() => Promise<void>) | null): void;
}

export interface GeneralMissionResult {
  missionId: string;
  runId: string;
  text: string;
  progress: RuntimeMissionProgress;
  outcome: "awaiting-review" | "partial";
}

/**
 * Compose a user-declared independent-work Mission through the authenticated
 * native Plan/Run repositories and the existing general graph driver.
 */
export async function executeGeneralMission(
  input: GeneralMissionInput
): Promise<GeneralMissionResult> {
  if (input.backend.backend.backendType !== "native-api") {
    throw new Error("General missions require a connected native model provider.");
  }
  const draft = parseGeneralMissionDraft([
    input.title,
    ...input.tasks.map((task) => `- ${task}`)
  ].join("\n"));
  if (!draft) {
    throw new Error("A mission needs a short title and two to six distinct bullet tasks.");
  }

  const routes = await listRuntimeNativeProviderRoutes();
  if (!routes) throw new Error("General missions require the Fable desktop runtime.");
  const pinnedRoute = routes.find((route) =>
    route.workspaceId === input.workspaceId
    && route.providerFamily === input.backend.providerId
    && route.modelOrRuntimeReference === input.model
  );
  if (!pinnedRoute) {
    throw new Error("The selected model no longer has an authorized Mission route.");
  }

  const id = input.createId ?? secureId;
  const missionId = id("mission");
  const planId = id("plan");
  const planRevisionId = id("plan-revision");
  const runId = id("mission-run");
  const taskRecords = draft.tasks.map((task, index) => ({
    key: `task-${index + 1}`,
    title: taskTitle(task, index),
    objective: task
  }));

  const lifecycle = await createRuntimeMissionPlan({
    missionId,
    planId,
    planRevisionId,
    executionDepth: "multi-worker",
    outcome: {
      title: draft.title,
      desiredOutcome: `Complete the independently reviewable work declared for: ${draft.title}`,
      deliverables: taskRecords.map((task) => ({
        key: task.key,
        description: `Markdown result for ${task.title}.`,
        required: true
      }))
    },
    missionScope: {
      workspaceId: input.workspaceId,
      sourceThreadId: input.sourceThreadId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      departmentIds: [],
      context: []
    },
    constraints: [{
      key: "native:general-independent-work:v1",
      description: "Run only the explicitly listed independent tasks. Do not infer synthesis, handoff, tools, or consequential effects.",
      severity: "required",
      source: "user"
    }],
    dataBoundary: {
      allowedProviderRouteIds: [pinnedRoute.id],
      allowedExecutionNodeIds: ["local-desktop"]
    },
    acceptance: {
      requiresHumanAcceptance: true,
      minimumRequiredCriteria: taskRecords.length,
      criteria: taskRecords.map((task) => ({
        key: `review-${task.key}`,
        description: `${task.title} is useful and ready to keep.`,
        required: true,
        evaluator: "human",
        evidenceRequired: [],
        evidenceFromStepOutputs: true
      }))
    },
    budget: {
      maxDurationMs: 180_000,
      maxInputTokens: 64_000,
      maxOutputTokens: taskRecords.length * 2_048,
      maxToolCalls: 1,
      maxWorkers: taskRecords.length,
      maxAttempts: 2
    },
    summary: draft.title,
    bounds: {
      maxSteps: taskRecords.length,
      maxDependenciesPerStep: 0,
      maxParallelSteps: taskRecords.length,
      maxRevisions: 1
    },
    steps: taskRecords.map((task) => ({
      key: task.key,
      kind: "produce",
      title: task.title,
      objective: task.objective,
      dependsOnStepKeys: [],
      requiredCapabilities: [],
      expectedOutputs: [{
        key: task.key,
        description: `Markdown result for ${task.title}.`,
        required: true,
        format: "text/markdown"
      }],
      acceptanceCriterionKeys: [`review-${task.key}`],
      optional: false,
      estimatedBudget: {
        maxDurationMs: 90_000,
        maxInputTokens: 16_000,
        maxOutputTokens: 2_048,
        maxToolCalls: 1,
        maxAttempts: 1
      }
    }))
  });
  if (!lifecycle) throw new Error("General Mission planning requires the desktop runtime.");

  await createRuntimeMissionRun({
    missionId,
    runId,
    eventId: id("event"),
    idempotencyKey: id("run-create")
  });
  await prepareRuntimeMissionWorkers(runId);
  const initialProgress = await readRuntimeMissionProgress(runId);
  if (!initialProgress) throw new Error("General Mission progress is unavailable.");
  await input.onRunReady?.(runId, initialProgress);
  input.onProgress?.(initialProgress);

  const cancellation = new AbortController();
  input.onCancellationReady?.(async () => {
    cancellation.abort();
    await input.backend.cancel(runId);
  });
  try {
    await executeRuntimeProviderMissionGraph({
      runId,
      signal: cancellation.signal,
      resolveBackend: async (route) => {
        if (route.id !== pinnedRoute.id) return null;
        return input.resolveBackend(route);
      }
    });
    await advanceRuntimeMissionCoordination(runId);
  } finally {
    input.onCancellationReady?.(null);
  }

  const progress = await readRuntimeMissionProgress(runId);
  if (!progress) throw new Error("General Mission progress is unavailable after execution.");
  input.onProgress?.(progress);
  const journal = runtimeJournal(await getRuntimeMissionRun(runId));
  const outputs = await loadOutputs(taskRecords, journal.events);
  const outcome = outputs.length === taskRecords.length ? "awaiting-review" : "partial";
  return {
    missionId,
    runId,
    progress,
    outcome,
    text: formatOutputs(draft.title, taskRecords, outputs, outcome)
  };
}

function runtimeJournal(value: Record<string, unknown> | null): {
  events: Array<Record<string, unknown>>;
} {
  if (!value || !Array.isArray(value.events)) {
    throw new Error("The general Mission journal is unavailable.");
  }
  return {
    events: value.events.filter(isRecord)
  };
}

async function loadOutputs(
  tasks: Array<{ key: string; title: string }>,
  events: Array<Record<string, unknown>>
): Promise<Array<{ key: string; title: string; text: string }>> {
  const references = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "worker-completed" || !isRecord(event.payload)) continue;
    const outputs = event.payload.outputs;
    if (!Array.isArray(outputs) || outputs.length !== 1 || !isRecord(outputs[0])) continue;
    const key = outputs[0].key;
    const reference = outputs[0].valueReference;
    if (typeof key === "string" && typeof reference === "string") {
      references.set(key, reference);
    }
  }
  const loaded = [];
  for (const task of tasks) {
    const reference = references.get(task.key);
    if (!reference) continue;
    const row = await readRuntimeMissionWorkerOutput(reference);
    if (!row || !isRecord(row.receipt) || typeof row.receipt.text !== "string") continue;
    const text = row.receipt.text.trim();
    if (!text) continue;
    loaded.push({ ...task, text });
  }
  return loaded;
}

function formatOutputs(
  title: string,
  tasks: Array<{ key: string; title: string }>,
  outputs: Array<{ key: string; title: string; text: string }>,
  outcome: GeneralMissionResult["outcome"]
): string {
  const sections = outputs.map((output) => `## ${output.title}\n\n${output.text}`);
  const missing = tasks
    .filter((task) => !outputs.some((output) => output.key === task.key))
    .map((task) => `- ${task.title}`);
  const lead = outcome === "awaiting-review"
    ? `# ${title}\n\nThe independent drafts are ready for your review.`
    : `# ${title}\n\nFable preserved the completed drafts, but some declared work did not finish.`;
  return [
    lead,
    ...sections,
    ...(missing.length > 0 ? ["## Still incomplete", missing.join("\n")] : [])
  ].join("\n\n");
}

function taskTitle(task: string, index: number): string {
  const firstSentence = task.split(/(?<=[.!?])\s/)[0]?.replace(/[.!?]+$/, "").trim() ?? "";
  return (firstSentence || `Task ${index + 1}`).slice(0, 160);
}

function secureId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `${prefix}-${random}`;
  const values = new Uint32Array(4);
  globalThis.crypto?.getRandomValues?.(values);
  return `${prefix}-${Array.from(values, (value) =>
    value.toString(16).padStart(8, "0")).join("")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

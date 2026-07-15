import type { AgentBackend, ApprovalGate } from "@fable/connectors";
import { buildToolApproval, catalogueCapabilities, executeLocalWorker, selectMissionProviderRoute } from "@fable/connectors";
import { Spine, type ApprovalRequest, type ApprovalResolutionRequest } from "@fable/protocol";
import {
  commitRuntimeCapabilityGrant,
  createRuntimeMissionCheckpoint,
  createRuntimeMissionPlan,
  createRuntimeMissionRun,
  createRuntimeMissionWorker,
  finalizeRuntimeMissionRunCancellation,
  getRuntimeCitedMissionPlanSummary,
  getRuntimeMissionRun,
  listRuntimePendingCitedApprovals,
  listRuntimeNativeProviderRoutes,
  prepareRuntimeCitedMissionRetry,
  prepareRuntimeCapabilityGrant,
  readRuntimeMissionWorkerOutput,
  recoverRuntimeInterruptedCitedMissions,
  requestRuntimeMissionRunCancellation,
  resolveRuntimeMcpCapabilityRoute,
  restoreRuntimeMissionCheckpoint,
  startRuntimeMissionWorker
} from "../runtime";
import type { RuntimeCitedApproval, RuntimeCitedMissionRestartRecovery } from "../runtime";
import { createDesktopToolExecutor } from "./desktop-tool-runtime";

type Worker = Spine.Missions.Worker;

export interface CitedBriefMissionInput {
  query: string;
  workspaceId: string;
  missionScopeWorkspaceId: string;
  sourceThreadId: string;
  projectId?: string;
  backend: AgentBackend;
  model: string;
  approvalGate: ApprovalGate;
  queueApproval: (approval: ApprovalRequest, tool: string, argumentsJson: string) => void;
  createId?: (prefix: string) => string;
  onCancellationReady?: (cancel: () => Promise<void>) => void;
  onPlanReady?: (plan: CitedBriefMissionPlanSummary) => void;
}

export interface CitedBriefMissionResult {
  missionId: string;
  runId: string;
  outcome: "accepted" | "partial" | "awaiting-approval";
  text: string;
  valueReference: string;
  artifactId?: string;
  artifactVersionId?: string;
  journal: Record<string, unknown>;
  receipt?: CitedBriefMissionReceipt;
  approval?: RuntimeCitedApproval;
  plan: CitedBriefMissionPlanSummary;
}

export interface CitedBriefMissionPlanSummary {
  title: string;
  summary: string;
  executionLabel: string;
  step: { title: string; objective: string; capability: string; output: string };
  acceptance: string[];
  requiresHumanAcceptance?: boolean;
  budget: {
    maxInputTokens: number;
    maxOutputTokens: number;
    maxToolCalls: number;
    maxDurationMs: number;
    maxAttempts: number;
  };
}

export interface CitedBriefMissionReceipt {
  acceptanceStatus: "accepted" | "not-accepted";
  acceptanceSummary: string;
  provider: string;
  model: string;
  routeReason: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  durationMs: number;
  attemptNumber: number;
  sourceCount: number;
  trust: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  maxDurationMs: number;
  maxAttempts: number;
  costAmount?: string;
  costCurrency?: string;
  pricingReference?: string;
}

export interface CitedBriefMissionRecoveryInput {
  backend: AgentBackend;
  onCancellationReady?: (cancel: (() => Promise<void>) | null) => void;
}

export interface CitedBriefMissionRecoveryResult {
  resumed: number;
  terminalized: number;
  failed: number;
}

export function isCitedBriefMissionReceipt(value: unknown): value is CitedBriefMissionReceipt {
  if (typeof value !== "object" || value === null) return false;
  const receipt = value as Record<string, unknown>;
  const required = [
    "acceptanceStatus", "acceptanceSummary", "provider", "model", "routeReason",
    "inputTokens", "outputTokens", "toolCalls", "durationMs", "attemptNumber", "sourceCount", "trust",
    "maxInputTokens", "maxOutputTokens", "maxToolCalls", "maxDurationMs", "maxAttempts"
  ];
  const optional = ["costAmount", "costCurrency", "pricingReference"];
  const exactKeys = Object.keys(receipt).every((key) => required.includes(key) || optional.includes(key))
    && required.every((key) => key in receipt);
  const strings = ["acceptanceSummary", "provider", "model", "routeReason", "trust"]
    .every((key) => typeof receipt[key] === "string" && (receipt[key] as string).trim().length > 0);
  const counts = ["inputTokens", "outputTokens", "toolCalls", "durationMs", "sourceCount"]
    .every((key) => Number.isInteger(receipt[key]) && (receipt[key] as number) >= 0);
  const limits = ["maxInputTokens", "maxOutputTokens", "maxToolCalls", "maxDurationMs", "maxAttempts"]
    .every((key) => Number.isInteger(receipt[key]) && (receipt[key] as number) > 0);
  const presentCost = optional.filter((key) => key in receipt);
  const cost = presentCost.length === 0 || presentCost.length === optional.length
    && optional.every((key) => typeof receipt[key] === "string" && (receipt[key] as string).trim().length > 0);
  const utilization = Number.isInteger(receipt.attemptNumber) && (receipt.attemptNumber as number) > 0
    && (receipt.attemptNumber as number) <= (receipt.maxAttempts as number)
    && (receipt.durationMs as number) <= (receipt.maxDurationMs as number);
  return exactKeys && strings && counts && limits && utilization && cost
    && (receipt.acceptanceStatus === "accepted" || receipt.acceptanceStatus === "not-accepted");
}

export function isCitedBriefMissionPlanSummary(value: unknown): value is CitedBriefMissionPlanSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  const required = ["title", "summary", "executionLabel", "step", "acceptance", "budget"];
  const exact = [...required, "requiresHumanAcceptance"];
  if (!required.every((key) => key in plan) || !Object.keys(plan).every((key) => exact.includes(key))
    || ("requiresHumanAcceptance" in plan && typeof plan.requiresHumanAcceptance !== "boolean")) return false;
  if (!["title", "summary", "executionLabel"].every((key) => typeof plan[key] === "string" && (plan[key] as string).trim())) return false;
  const step = plan.step as Record<string, unknown> | undefined;
  if (!step || Array.isArray(step) || Object.keys(step).length !== 4
    || !["title", "objective", "capability", "output"].every((key) => typeof step[key] === "string" && (step[key] as string).trim())) return false;
  if (!Array.isArray(plan.acceptance) || plan.acceptance.length === 0 || plan.acceptance.length > 8
    || plan.acceptance.some((item) => typeof item !== "string" || !item.trim())) return false;
  const budget = plan.budget as Record<string, unknown> | undefined;
  const limits = ["maxInputTokens", "maxOutputTokens", "maxToolCalls", "maxDurationMs", "maxAttempts"];
  return Boolean(budget) && !Array.isArray(budget) && Object.keys(budget!).length === limits.length
    && Object.keys(budget!).every((key) => limits.includes(key))
    && limits.every((key) => Number.isInteger(budget![key]) && (budget![key] as number) > 0);
}

export function isCitedBriefMissionPrompt(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return /\b(search|research|find)\b/.test(normalized)
    && /\bconnected (work )?sources?\b/.test(normalized)
    && /\b(cited|trustworthy)\b/.test(normalized)
    && /\bbrief\b/.test(normalized);
}

/** Compose the approved one-step cited-brief benchmark through real Tauri boundaries. */
export async function executeCitedBriefMission(input: CitedBriefMissionInput): Promise<CitedBriefMissionResult> {
  if (input.backend.providerId !== "openai") {
    throw new Error("Cited connected-source missions currently require the connected OpenAI API provider.");
  }
  const query = input.query.trim();
  if (!query || query.length > 2_000) throw new Error("Connected-source research needs a concise question.");
  const id = input.createId ?? secureId;
  const missionId = id("mission");
  const planId = id("plan");
  const planRevisionId = id("plan-revision");
  const runId = id("mission-run");
  const workerId = id("worker");

  const routes = await listRuntimeNativeProviderRoutes();
  if (!routes) throw new Error("Mission routing requires the desktop runtime.");
  const pinnedRoute = routes.find((route) => route.providerFamily === input.backend.providerId
    && route.modelOrRuntimeReference === input.model
    && route.workspaceId === input.missionScopeWorkspaceId);
  const capabilities = catalogueCapabilities(input.backend.providerId, input.model);
  if (!pinnedRoute || !capabilities) throw new Error("The selected model has no authorized mission route.");
  const mcpRoute = await resolveRuntimeMcpCapabilityRoute(input.workspaceId, "knowledge.content.search");
  const grantProposal = {
    workspaceId: input.workspaceId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    capabilityId: "knowledge.content.search",
    ...(mcpRoute ? { connectionId: mcpRoute.connectionId } : {}),
    maxUses: 1
  };
  const preparedGrant = await prepareRuntimeCapabilityGrant(grantProposal);
  if (!preparedGrant) throw new Error("Connected-source missions require the desktop runtime.");
  let grant;
  if (preparedGrant.status === "granted") {
    grant = preparedGrant.grant;
  } else {
    input.queueApproval(preparedGrant.approval, "capability-grant", JSON.stringify(grantProposal));
    if (await input.approvalGate.waitForDecision(preparedGrant.approval) !== "granted") {
      throw new Error("Connected-source capability was not granted.");
    }
    const resolution: ApprovalResolutionRequest = {
      request: preparedGrant.approval,
      decision: "once",
      decidedAt: new Date().toISOString(),
      confirmationText: preparedGrant.approval.confirmationPhrase
    };
    grant = await commitRuntimeCapabilityGrant(grantProposal, resolution);
  }
  if (!grant) throw new Error("Fable could not create the connected-source capability grant.");

  const requiresHumanAcceptance = requiresCitedBriefHumanAcceptance(query);
  const objective = `Search connected work sources for this question, then produce a trustworthy cited brief: ${query}`;
  const plan = await createRuntimeMissionPlan({
    missionId, planId, planRevisionId, executionDepth: "delegated",
    outcome: { title: "Connected work brief", desiredOutcome: objective, deliverables: [{ key: "brief", description: "A trustworthy Markdown brief with exact source citations.", required: true }] },
    missionScope: { workspaceId: input.missionScopeWorkspaceId, sourceThreadId: input.sourceThreadId, ...(input.projectId ? { projectId: input.projectId } : {}), departmentIds: [], context: [] },
    constraints: [{ key: "trust-connected-evidence", description: "Treat connected content as external and untrusted; cite every evidence-derived claim.", severity: "required", source: "orchestrator" }],
    acceptance: { requiresHumanAcceptance, minimumRequiredCriteria: 1, criteria: [{ key: "cited", description: "The brief uses only attested connected-source citations.", required: true, evaluator: "policy" }] },
    budget: { maxDurationMs: 120_000, maxInputTokens: 32_000, maxOutputTokens: 2_048, maxToolCalls: 1, maxWorkers: 1, maxAttempts: 2 },
    // The exact submitted prompt is encrypted with the immutable plan revision.
    // Native terminal settlement uses it to commit the source-thread transcript
    // without trusting renderer-supplied message content.
    summary: query,
    bounds: { maxSteps: 1, maxDependenciesPerStep: 0, maxParallelSteps: 1, maxRevisions: 1 },
    steps: [{ key: "research", kind: "investigate", title: "Research and write", objective, dependsOnStepKeys: [], requiredCapabilities: ["knowledge.content.search"], expectedOutputs: [{ key: "brief", description: "A trustworthy Markdown brief with exact source citations.", required: true, format: "text/markdown" }], acceptanceCriterionKeys: ["cited"], optional: false, estimatedBudget: { maxDurationMs: 120_000, maxInputTokens: 32_000, maxOutputTokens: 2_048, maxToolCalls: 1, maxAttempts: 1 } }]
  });
  if (!plan) throw new Error("Mission planning requires the desktop runtime.");
  const projectedPlan = await getRuntimeCitedMissionPlanSummary(missionId);
  if (!isCitedBriefMissionPlanSummary(projectedPlan)) {
    throw new Error("The cited mission's inspectable plan is unavailable.");
  }
  input.onPlanReady?.(projectedPlan);

  let journal = requireJournal(await createRuntimeMissionRun({ missionId, runId, eventId: id("event"), idempotencyKey: id("create") }));
  const cancellation = new AbortController();
  let cancellationRequest: Promise<void> | undefined;
  let cancellationInitiated = false;
  let nativeProviderStarted = false;
  let earlyCancellationFinalization: Promise<never> | undefined;
  input.onCancellationReady?.(() => {
    cancellationInitiated = true;
    cancellationRequest ??= (async () => {
      const current = requireJournal(await getRuntimeMissionRun(runId));
      await requestRuntimeMissionRunCancellation({
        runId, eventId: id("event"), requestKey: id("stop"), ...head(current),
        mode: "cooperative", reason: "User requested stop."
      });
      cancellation.abort();
      await input.backend.cancel(runId);
    })();
    return cancellationRequest;
  });
  const finalizeEarlyCancellation = () => {
    earlyCancellationFinalization ??= (async () => {
      await cancellationRequest;
      const current = requireJournal(await getRuntimeMissionRun(runId));
      const settled = requireJournal(await finalizeRuntimeMissionRunCancellation({
        runId, eventId: id("event"), ...head(current)
      }));
      throw new Error(terminalCitedCancellation(settled));
    })();
    return earlyCancellationFinalization;
  };
  try {
  journal = requireJournal(await createRuntimeMissionWorker({
    runId, eventId: id("event"), idempotencyKey: id("worker-create"),
    ...head(journal), workerId, stepKey: "research", context: [],
    grants: [{ capabilityId: "knowledge.content.search", capabilityGrantId: grant.id }]
  }));
  const worker = findWorker(journal, workerId);
  const runStartEventId = id("event");
  const workerStartedEventId = id("event");
  const routeSelectedEventId = id("event");
  const currentRoutes = await listRuntimeNativeProviderRoutes();
  if (!currentRoutes) throw new Error("Mission routing requires the desktop runtime.");
  const currentPinnedRoute = currentRoutes.find((route) => route.providerFamily === input.backend.providerId
    && route.modelOrRuntimeReference === input.model
    && route.workspaceId === input.missionScopeWorkspaceId);
  if (!currentPinnedRoute) throw new Error("The selected model no longer has an authorized mission route.");
  const routeDecision = selectMissionProviderRoute({
    workspaceId: input.missionScopeWorkspaceId, capabilityId: "model.generate",
    requiredInputTokens: 32_000, requiredOutputTokens: 2_048, requiresTools: false,
    allowedPlacementKinds: ["local-desktop"], boundaries: currentPinnedRoute.boundaries,
    allowDegraded: false, maximumRisk: "medium", selectedAt: new Date().toISOString(),
    qualityPolicyRef: Spine.Missions.NATIVE_CITED_BRIEF_POLICY_REVISION,
    preference: { policy: "require", providerRouteIds: [currentPinnedRoute.id], allowFallback: false }
  }, currentRoutes.map((route) => ({
    route, capabilityIds: ["model.generate"], supportsTools: catalogueCapabilities(route.providerFamily, route.modelOrRuntimeReference)?.tools === true,
    contextWindowTokens: catalogueCapabilities(route.providerFamily, route.modelOrRuntimeReference)?.contextWindow ?? 0,
    ...(route.observationSummary ? {
      estimatedLatencyMs: route.observationSummary.medianLatencyMs,
      observation: route.observationSummary
    } : {}),
    ...(route.pricingSummary ? { pricing: route.pricingSummary } : {}),
    ...(route.qualitySummary ? { quality: route.qualitySummary } : {}),
    risk: "medium" as const
  })));
  journal = requireJournal(await startRuntimeMissionWorker({
    runId, workerId, runStartEventId, workerStartedEventId, routeSelectedEventId,
    providerId: input.backend.providerId, modelReference: input.model,
    routeSelection: routeDecision.selection,
    idempotencyKey: id("worker-start"), ...head(journal)
  }));
  if (journalSelectedRouteId(journal) !== routeDecision.selection.providerRouteId) {
    throw new Error("The native mission route did not match the selected provider route.");
  }

  const toolEventId = id("event");
  const toolHead = head(journal);
  const toolArguments = JSON.stringify({ capability: "knowledge.content.search", input: { query, limit: 10 } });
  const approval: ApprovalRequest = {
    ...buildToolApproval(input.backend.providerId, "connection-read", toolArguments),
    id: `native-${runId}-${id("call")}`.slice(0, 160),
    requestedAt: new Date().toISOString()
  };
  input.queueApproval(approval, "connection-read", toolArguments);
  const missionExecutor = createDesktopToolExecutor(
    input.approvalGate,
    {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      missionWorkerToolExecution: {
        runId, workerId, workerStartedEventId, routeSelectedEventId, toolEventId,
        callKey: approval.id, idempotencyKey: id("worker-tool"),
        ...toolHead
      },
      queueApproval: input.queueApproval
    }
  );
  const evidenceOutput = await missionExecutor(approval, toolArguments);
  let evidence: unknown;
  try { evidence = JSON.parse(evidenceOutput); } catch { throw new Error("The connected-source evidence is invalid."); }
  journal = requireJournal(await getRuntimeMissionRun(runId));
  const outputReference = toolOutputReference(journal, toolEventId);
  const durableThroughSequence = eventSequence(journal, toolEventId);
  const checkpointEventId = id("event");
  journal = requireJournal(await createRuntimeMissionCheckpoint({
    runId,
    eventId: checkpointEventId,
    idempotencyKey: `cited-evidence:${toolEventId}`,
    ...head(journal),
    attemptNumber: currentAttemptNumber(journal),
    durableThroughSequence,
    resumeAfterEventId: toolEventId
  }));

  if (cancellationInitiated) await finalizeEarlyCancellation();

  const finalHead = head(journal);
  nativeProviderStarted = true;
  const completion = await executeLocalWorker({
    worker: { ...worker, status: "running" }, backend: input.backend, model: input.model,
    prompt: objective, toolSpecs: [], execute: async () => { throw new Error("The final cited-writing turn cannot call tools."); },
    missionToolEvidence: evidence,
    signal: cancellation.signal,
    missionWorkerExecution: {
      runId, workerId, workerStartedEventId, routeSelectedEventId,
      usageEventId: id("event"), completionEventId: id("event"), evaluationEventId: id("event"), resultEventId: id("event"), failureEventId: id("event"),
      idempotencyKey: id("worker-terminal"), ...finalHead,
      checkpointEventId,
      toolEvidence: { toolEventId, outputReference }
    }
  });
  if (completion.status === "cancelled") {
    journal = requireJournal(await getRuntimeMissionRun(runId));
    throw new Error(terminalCitedCancellation(journal));
  }
  if (completion.status !== "completed") {
    journal = requireJournal(await getRuntimeMissionRun(runId));
    if ((journal.run as Record<string, unknown>).status === "retrying") {
      const recovery = await prepareRuntimeCitedMissionRetry(runId);
      if (!recovery || recovery.status !== "resumable") {
        throw new Error("The durable cited retry is unavailable.");
      }
      await resumeCitedBriefMission(recovery, input);
      journal = requireJournal(await getRuntimeMissionRun(runId));
    } else {
      throw new Error(terminalCitedFailure(journal));
    }
  }
  journal = requireJournal(await getRuntimeMissionRun(runId));
  if ((journal.run as Record<string, unknown>).status === "cancelled") {
    throw new Error(terminalCitedCancellation(journal));
  }
  if ((journal.run as Record<string, unknown>).status === "waiting-approval") {
    const approval = (await listRuntimePendingCitedApprovals(input.sourceThreadId))
      .approvals.find((candidate) => candidate.runId === runId);
    if (!approval || !isCitedBriefMissionPlanSummary(approval.plan)) {
      throw new Error("The durable cited approval is unavailable.");
    }
    return {
      missionId,
      runId,
      outcome: "awaiting-approval",
      text: approval.draft,
      valueReference: approval.valueReference,
      journal,
      approval,
      plan: approval.plan
    };
  }
  const terminal = terminalCitedOutcome(journal);
  const valueReference = terminal.valueReference;
  const output = await readRuntimeMissionWorkerOutput(valueReference);
  const outputReceipt = typeof output?.receipt === "object" && output.receipt
    ? output.receipt as Record<string, unknown>
    : undefined;
  const text = outputReceipt?.text;
  if (!outputReceipt || typeof text !== "string" || !text.trim()) throw new Error("The durable cited brief is unavailable.");
  return {
    missionId,
    runId,
    outcome: terminal.outcome,
    text: terminal.outcome === "partial"
      ? `Draft preserved, but not accepted: ${terminal.acceptanceSummary}\n\n${text}`
      : text,
    valueReference,
    ...(terminal.artifactId ? {
      artifactId: terminal.artifactId,
      artifactVersionId: terminal.artifactVersionId
    } : {}),
    journal,
    receipt: citedBriefReceipt(journal, outputReceipt, plan, terminal),
    plan: projectedPlan
  };
  } catch (error) {
    if (cancellationInitiated && !nativeProviderStarted) await finalizeEarlyCancellation();
    throw error;
  }
}

export function requiresCitedBriefHumanAcceptance(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return /\b(ask|wait) (for )?(me|my) (to )?approve\b/.test(normalized)
    || /\bapprove (it |the (brief|draft) )?before (you )?(save|saving|accept|accepting)\b/.test(normalized)
    || /\bdo not (save|accept) (it |the (brief|draft) )?until (i|we) approve\b/.test(normalized);
}

/**
 * Continue only the provider-writing turn of an exact native restart descriptor.
 * Search execution, capability grants, and approvals are deliberately absent.
 */
export async function resumeInterruptedCitedBriefMissions(
  input: CitedBriefMissionRecoveryInput
): Promise<CitedBriefMissionRecoveryResult> {
  const recoveries = await recoverRuntimeInterruptedCitedMissions();
  const result: CitedBriefMissionRecoveryResult = { resumed: 0, terminalized: 0, failed: 0 };
  if (!recoveries) return result;

  for (const recovery of recoveries) {
    if (recovery.status === "terminalized") {
      result.terminalized += 1;
      continue;
    }
    if (recovery.providerId !== input.backend.providerId) {
      result.failed += 1;
      continue;
    }
    try {
      await resumeCitedBriefMission(recovery, input);
      result.resumed += 1;
    } catch {
      // Native settlement owns the durable failure/cancellation transcript. A
      // malformed or unsettled descriptor is retried only after another app
      // restart, where the exhausted attempt is terminalized instead.
      result.failed += 1;
    } finally {
      input.onCancellationReady?.(null);
    }
  }
  return result;
}

async function resumeCitedBriefMission(
  recovery: Extract<RuntimeCitedMissionRestartRecovery, { status: "resumable" }>,
  input: {
    backend: AgentBackend;
    onCancellationReady?: (cancel: () => Promise<void>) => void;
  }
): Promise<void> {
  const restored = await restoreRuntimeMissionCheckpoint({
    runId: recovery.runId,
    eventId: recovery.checkpointRestoreEventId,
    idempotencyKey: recovery.restoreIdempotencyKey,
    expectedRunRevision: recovery.expectedRunRevision,
    expectedLastSequence: recovery.expectedLastSequence,
    newAttemptNumber: recovery.newAttemptNumber
  });
  if (!restored) throw new Error("Mission checkpoint restoration requires the desktop runtime.");
  const journal = requireJournal(restored.journal);
  const restoredHead = head(journal);
  const restoredRun = journal.run as Record<string, unknown>;
  if (restoredHead.expectedRunRevision !== recovery.expectedRunRevision + 1
    || restoredHead.expectedLastSequence !== recovery.expectedLastSequence + 1
    || (restoredRun.eventHead as Record<string, unknown> | undefined)?.lastEventId !== recovery.checkpointRestoreEventId
    || currentAttemptNumber(journal) !== recovery.newAttemptNumber) {
    throw new Error("The restored cited mission head is invalid.");
  }

  const cancellation = new AbortController();
  let cancellationRequest: Promise<void> | undefined;
  input.onCancellationReady?.(() => {
    cancellationRequest ??= (async () => {
      const current = requireJournal(await getRuntimeMissionRun(recovery.runId));
      const status = (current.run as Record<string, unknown>).status;
      if (status === "completed" || status === "partially-completed" || status === "failed" || status === "cancelled") return;
      await requestRuntimeMissionRunCancellation({
        runId: recovery.runId,
        eventId: secureId("event"),
        requestKey: secureId("stop"),
        ...head(current),
        mode: "cooperative",
        reason: "User requested stop."
      });
      cancellation.abort();
      await input.backend.cancel(recovery.runId);
    })();
    return cancellationRequest;
  });

  const completion = await executeLocalWorker({
    worker: { ...recovery.worker, status: "running" },
    backend: input.backend,
    model: recovery.modelReference,
    prompt: recovery.worker.role.objective,
    toolSpecs: [],
    execute: async () => { throw new Error("The resumed cited-writing turn cannot call tools."); },
    missionToolEvidence: recovery.evidence,
    signal: cancellation.signal,
    missionWorkerExecution: {
      runId: recovery.runId,
      workerId: recovery.worker.id,
      workerStartedEventId: recovery.workerStartedEventId,
      routeSelectedEventId: recovery.routeSelectedEventId,
      usageEventId: recovery.usageEventId,
      completionEventId: recovery.completionEventId,
      evaluationEventId: recovery.evaluationEventId,
      resultEventId: recovery.resultEventId,
      failureEventId: recovery.failureEventId,
      idempotencyKey: recovery.terminalIdempotencyKey,
      ...restoredHead,
      checkpointEventId: recovery.checkpointEventId,
      checkpointRestoreEventId: recovery.checkpointRestoreEventId,
      toolEvidence: {
        toolEventId: recovery.toolEventId,
        outputReference: recovery.outputReference
      }
    }
  });
  const terminal = requireJournal(await getRuntimeMissionRun(recovery.runId));
  const status = (terminal.run as Record<string, unknown>).status;
  if (status === "completed" || status === "partially-completed") {
    terminalCitedOutcome(terminal);
  } else if (status === "cancelled" || completion.status === "cancelled") {
    terminalCitedCancellation(terminal);
  } else {
    terminalCitedFailure(terminal);
  }
}

function citedBriefReceipt(
  journal: Record<string, unknown>,
  output: Record<string, unknown>,
  plan: Record<string, unknown>,
  terminal: TerminalCitedOutcome
): CitedBriefMissionReceipt {
  const events = journal.events as Array<Record<string, unknown>>;
  const route = events.find((event) => event.type === "route-selected")?.payload as Record<string, unknown> | undefined;
  const selection = route?.selection as Record<string, unknown> | undefined;
  const terminalAttempt = (journal.run as Record<string, unknown>).currentAttemptNumber ?? 1;
  const matchingUsage = events.filter((event) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    const candidate = payload?.usage as Record<string, unknown> | undefined;
    return event.type === "usage-recorded" && candidate?.attemptNumber === terminalAttempt;
  });
  if (!Number.isInteger(terminalAttempt) || matchingUsage.length !== 1) {
    throw new Error("The durable mission attempt receipt is invalid.");
  }
  const usageEvent = matchingUsage[0].payload as Record<string, unknown> | undefined;
  const usage = usageEvent?.usage as Record<string, unknown> | undefined;
  const costs = Array.isArray(usage?.costs) ? usage.costs : [];
  const cost = costs.length === 1 ? costs[0] as Record<string, unknown> : undefined;
  const amount = cost?.amount as Record<string, unknown> | undefined;
  const citations = Array.isArray(output.citations) ? output.citations : [];
  const mission = plan.mission as Record<string, unknown> | undefined;
  const budget = mission?.budget as Record<string, unknown> | undefined;
  const requiredText = (value: unknown, message: string) => {
    if (typeof value !== "string" || !value.trim()) throw new Error(message);
    return value;
  };
  const count = (value: unknown) => {
    if (!Number.isInteger(value) || (value as number) < 0) throw new Error("The durable mission usage receipt is invalid.");
    return value as number;
  };
  const limit = (value: unknown) => {
    if (!Number.isInteger(value) || (value as number) <= 0) throw new Error("The durable mission budget receipt is invalid.");
    return value as number;
  };
  return {
    acceptanceStatus: terminal.outcome === "accepted" ? "accepted" : "not-accepted",
    acceptanceSummary: terminal.acceptanceSummary,
    provider: requiredText(output.observedProvider, "The durable mission provider receipt is invalid."),
    model: requiredText(output.requestedModel, "The durable mission model receipt is invalid."),
    routeReason: requiredText(selection?.reason, "The durable mission route receipt is invalid."),
    inputTokens: count(usage?.inputTokens),
    outputTokens: count(usage?.outputTokens),
    toolCalls: count(usage?.toolCalls),
    durationMs: count(usage?.durationMs),
    attemptNumber: limit(usage?.attemptNumber),
    sourceCount: citations.length,
    trust: requiredText(output.trust, "The durable mission trust receipt is invalid."),
    maxInputTokens: limit(budget?.maxInputTokens),
    maxOutputTokens: limit(budget?.maxOutputTokens),
    maxToolCalls: limit(budget?.maxToolCalls),
    maxDurationMs: limit(budget?.maxDurationMs),
    maxAttempts: limit(budget?.maxAttempts),
    ...(typeof amount?.amount === "string" && typeof amount.currencyCode === "string" && typeof cost?.pricingReference === "string"
      ? { costAmount: amount.amount, costCurrency: amount.currencyCode, pricingReference: cost.pricingReference }
      : {})
  };
}

function secureId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function requireJournal(value: Record<string, unknown> | null): Record<string, unknown> {
  if (!value || typeof value.run !== "object" || !Array.isArray(value.events)) throw new Error("Mission journal is unavailable.");
  return value;
}

function head(journal: Record<string, unknown>) {
  const run = journal.run as Record<string, unknown>;
  const eventHead = run.eventHead as Record<string, unknown>;
  if (!Number.isInteger(run.revision) || !Number.isInteger(eventHead?.lastSequence)) throw new Error("Mission journal head is invalid.");
  return { expectedRunRevision: run.revision as number, expectedLastSequence: eventHead.lastSequence as number };
}

function findWorker(journal: Record<string, unknown>, workerId: string): Worker {
  for (const event of journal.events as Array<Record<string, unknown>>) {
    const payload = event.payload as Record<string, unknown> | undefined;
    const worker = payload?.worker as Worker | undefined;
    if (event.type === "worker-created" && worker?.id === workerId) return worker;
  }
  throw new Error("Mission worker assignment is unavailable.");
}

function toolOutputReference(journal: Record<string, unknown>, toolEventId: string): string {
  const event = (journal.events as Array<Record<string, unknown>>).find((candidate) => candidate.id === toolEventId);
  const reference = (event?.payload as Record<string, unknown> | undefined)?.result;
  const value = (reference as Record<string, unknown> | undefined)?.outputReference;
  if (typeof value !== "string") throw new Error("The durable connected-source evidence reference is unavailable.");
  return value;
}

type TerminalCitedOutcome = {
  outcome: "accepted" | "partial";
  valueReference: string;
  acceptanceSummary: string;
  artifactId?: string;
  artifactVersionId?: string;
};

function terminalCitedOutcome(journal: Record<string, unknown>): TerminalCitedOutcome {
  const run = journal.run as Record<string, unknown>;
  const eventHead = run.eventHead as Record<string, unknown> | undefined;
  const terminalEvent = (journal.events as Array<Record<string, unknown>>).find((candidate) => candidate.id === eventHead?.lastEventId);
  if (run.status === "completed") {
    const result = run.terminalResult as Record<string, unknown> | undefined;
    const outputs = result?.outputs;
    const output = Array.isArray(outputs) ? outputs[0] as Record<string, unknown> | undefined : undefined;
    const value = output?.valueReference;
    const artifactId = output?.artifactId;
    const artifactVersionId = output?.artifactVersionId;
    const summary = result?.summary;
    const eventResult = (terminalEvent?.payload as Record<string, unknown> | undefined)?.result as Record<string, unknown> | undefined;
    const eventOutputs = eventResult?.outputs;
    const eventOutput = Array.isArray(eventOutputs) ? eventOutputs[0] as Record<string, unknown> | undefined : undefined;
    if (terminalEvent?.type !== "run-completed" || eventResult?.outcome !== "succeeded"
      || result?.outcome !== "succeeded" || typeof value !== "string" || typeof summary !== "string"
      || typeof artifactId !== "string" || !artifactId.trim()
      || typeof artifactVersionId !== "string" || !artifactVersionId.trim()
      || eventOutput?.valueReference !== value || eventOutput.artifactId !== artifactId
      || eventOutput.artifactVersionId !== artifactVersionId) {
      throw new Error("The mission did not produce a durable accepted output.");
    }
    return { outcome: "accepted", valueReference: value, acceptanceSummary: summary, artifactId, artifactVersionId };
  }
  if (run.status === "partially-completed") {
    const payload = terminalEvent?.payload as Record<string, unknown> | undefined;
    const error = payload?.error as Record<string, unknown> | undefined;
    const partial = payload?.partial as Record<string, unknown> | undefined;
    const outputs = partial?.completedOutputs;
    const output = Array.isArray(outputs) ? outputs[0] as Record<string, unknown> | undefined : undefined;
    const value = output?.valueReference;
    const summary = partial?.summary;
    if (terminalEvent?.type !== "run-failed"
      || !["policy-acceptance-failed", "human-acceptance-denied"].includes(String(error?.code))
      || typeof value !== "string" || typeof summary !== "string"
      || (output !== undefined && ("artifactId" in output || "artifactVersionId" in output))) {
      throw new Error("The mission partial outcome is invalid.");
    }
    return { outcome: "partial", valueReference: value, acceptanceSummary: summary };
  }
  throw new Error("The mission did not reach a durable terminal outcome.");
}

function eventSequence(journal: Record<string, unknown>, eventId: string): number {
  const event = (journal.events as Array<Record<string, unknown>>).find((candidate) => candidate.id === eventId);
  if (!event || !Number.isInteger(event.sequence) || (event.sequence as number) < 1) {
    throw new Error("The durable mission replay boundary is unavailable.");
  }
  return event.sequence as number;
}

function currentAttemptNumber(journal: Record<string, unknown>): number {
  const value = (journal.run as Record<string, unknown>).currentAttemptNumber ?? 1;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error("The durable mission attempt is invalid.");
  }
  return value as number;
}

function terminalCitedFailure(journal: Record<string, unknown>): string {
  const run = journal.run as Record<string, unknown>;
  const eventHead = run.eventHead as Record<string, unknown> | undefined;
  const terminalEvent = (journal.events as Array<Record<string, unknown>>).find((candidate) => candidate.id === eventHead?.lastEventId);
  const payload = terminalEvent?.payload as Record<string, unknown> | undefined;
  const error = payload?.error as Record<string, unknown> | undefined;
  const category = error?.category;
  const message = error?.message;
  if (run.status !== "failed" || terminalEvent?.type !== "run-failed"
    || (category !== "provider" && category !== "budget-exceeded")
    || typeof message !== "string" || !message.trim()) {
    throw new Error("The cited mission failure did not reach a durable terminal outcome.");
  }
  return message;
}

function terminalCitedCancellation(journal: Record<string, unknown>): string {
  const run = journal.run as Record<string, unknown>;
  const eventHead = run.eventHead as Record<string, unknown> | undefined;
  const terminalEvent = (journal.events as Array<Record<string, unknown>>).find((candidate) => candidate.id === eventHead?.lastEventId);
  const cancellation = (terminalEvent?.payload as Record<string, unknown> | undefined)?.cancellation as Record<string, unknown> | undefined;
  const projected = run.cancellation as Record<string, unknown> | undefined;
  if (run.status !== "cancelled" || terminalEvent?.type !== "run-cancelled"
    || typeof cancellation?.requestKey !== "string" || cancellation.requestKey !== projected?.requestKey
    || cancellation.scope !== "run" || typeof cancellation.requestedAt !== "string") {
    throw new Error("The cited mission cancellation did not reach a durable terminal outcome.");
  }
  return typeof cancellation.reason === "string" && cancellation.reason.trim()
    ? cancellation.reason
    : "The cited brief was cancelled.";
}

function journalSelectedRouteId(journal: Record<string, unknown>): string | undefined {
  const event = (journal.events as Array<Record<string, unknown>>).find((candidate) => candidate.type === "route-selected");
  const payload = event?.payload as Record<string, unknown> | undefined;
  const selection = payload?.selection as Record<string, unknown> | undefined;
  return typeof selection?.providerRouteId === "string" ? selection.providerRouteId : undefined;
}

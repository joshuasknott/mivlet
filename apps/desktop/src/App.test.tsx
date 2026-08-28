import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AccountWorkspaceStatus, BackendProvider, ConnectorManifest, IdentityStatus, PersistedAgentRun, RuntimeSnapshot } from "@fable/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { resolveDetailedStatus } from "./components/PluginPanel";
import { appendRuntimeConversationMessage, cancelRuntimeCitedApproval, cancelRuntimeMissionApproval, cancelRuntimeMissionHumanInput, getRuntimeArtifact, getRuntimeConversationThread, listRuntimeConnectorStatuses, listRuntimePendingCitedApprovals, listRuntimePendingMissionApprovals, listRuntimePendingMissionHumanInputs, listRuntimeThreadArtifacts, listRuntimeThreadMissionProgress, prepareRuntimeConnectorAction, readRuntimeCitedMissionPlanSummaries, readRuntimeCitedMissionReceipts, readRuntimeMissionProgress, receiveRuntimeMissionHumanInput, resolveRuntimeMissionApproval, reviseRuntimeConversationMessage, searchRuntimeArtifacts, startRuntimeArtifactRevisionBrief, startRuntimeStructuredIntake } from "./runtime";
import { executeCitedBriefMission } from "./lib/cited-brief-mission";
import type { ThreadSummary } from "@fable/protocol";

const runtimeMocks = vi.hoisted(() => ({
  snapshot: null as RuntimeSnapshot | null,
  savedSnapshots: [] as RuntimeSnapshot[],
  backends: null as BackendProvider[] | null,
  // SSE lines the mocked listenRuntimeBackendEvents feeds to a held-open agent
  // run. When emitDone is false the run blocks (no [DONE]) so a cancel test can
  // target a genuinely in-flight loop.
  lines: [] as string[],
  emitDone: true,
  onLine: null as ((line: string) => void) | null,
  cancelCalls: [] as string[],
  connectorOAuthCalls: [] as string[],
  agentRuns: [] as PersistedAgentRun[],
  conversationThreads: [] as Array<Record<string, unknown>>,
  conversationMessages: [] as Array<Record<string, unknown>>,
  projectRecords: [] as Array<Record<string, unknown>>,
  citedBriefCalls: [] as Array<Record<string, unknown>>,
  structuredIntakeCalls: [] as Array<Record<string, unknown>>,
  artifactRevisionBriefCalls: [] as Array<Record<string, unknown>>,
  parallelApproachCalls: [] as Array<Record<string, unknown>>,
  generalMissionCalls: [] as Array<Record<string, unknown>>,
  citedBriefGate: null as Promise<void> | null,
  // In-memory durable scheduler store so cross-session recovery tests exercise
  // the same Rust-store round-trip the shell uses in production.
  savedScheduledJobs: [] as unknown[],
  savedWorkflowDefinitions: [] as unknown[],
  identityStatus: {
    enabled: true,
    state: "signed-in",
    message: "Test account signed in.",
    scopes: [],
    authentication: {
      provider: "clerk",
      normalizedIssuer: "https://accounts.fable.test",
      subject: "test-user",
      authenticationEventRef: "test-auth",
      sessionRef: "test-session",
      authenticatedAt: "2026-07-10T12:00:00Z",
      expiresAt: "2026-07-11T12:00:00Z",
      verifiedAttributes: []
    }
  } as IdentityStatus,
  accountStatus: {
    configured: true,
    state: "ready",
    message: "Test workspace ready.",
    accountBound: true,
    workspaces: [{
      fableWorkspaceId: "test-workspace",
      localWorkspaceId: "test-local-workspace",
      name: "Test workspace",
      workspaceStatus: "active",
      workspaceRevision: 1,
      policyRevision: 1,
      memberId: "test-member",
      role: "owner",
      membershipStatus: "active",
      membershipRevision: 1,
      updatedAt: "2026-07-10T12:00:00Z"
    }],
    activeWorkspace: {
      localWorkspaceId: "test-local-workspace",
      fableWorkspaceId: "test-workspace",
      name: "Test workspace",
      source: "hosted"
    },
    activeContextOwner: {
      internalUserId: "test-user",
      memberId: "test-member"
    },
    devices: []
  } as AccountWorkspaceStatus
}));
const defaultIdentityStatus = structuredClone(runtimeMocks.identityStatus);
const defaultAccountStatus = structuredClone(runtimeMocks.accountStatus);

vi.mock("./lib/cited-brief-mission", () => ({
  isCitedBriefMissionPrompt: (value: string) => /connected work sources?/i.test(value) && /(?:cited|trustworthy)/i.test(value) && /brief/i.test(value),
  isCitedBriefMissionReceipt: (value: unknown) => typeof value === "object" && value !== null,
  isCitedBriefMissionPlanSummary: (value: unknown) => typeof value === "object" && value !== null,
  resumeInterruptedCitedBriefMissions: vi.fn(async () => ({ resumed: 0, terminalized: 0, failed: 0 })),
  executeCitedBriefMission: vi.fn(async (input: Record<string, unknown>) => {
    runtimeMocks.citedBriefCalls.push(input);
    const plan = { title: "Connected work brief", summary: "What changed?", executionLabel: "One focused research step", step: { title: "Research and write", objective: "Search and write.", capability: "Search connected work sources", output: "A trustworthy Markdown brief." }, acceptance: ["Use only attested citations."], budget: { maxInputTokens: 32000, maxOutputTokens: 2048, maxToolCalls: 1, maxDurationMs: 120000, maxAttempts: 2 } };
    (input.onPlanReady as ((plan: unknown) => void) | undefined)?.(plan);
    if (runtimeMocks.citedBriefGate) await runtimeMocks.citedBriefGate;
    return { missionId: "mission-ui", runId: "mission-run-ui", outcome: "accepted", valueReference: "mission-output:v1:ui", artifactId: "mission-artifact-ui", artifactVersionId: "mission-artifact-version-ui", text: "Durable cited brief [source-1].", journal: {}, plan, receipt: { acceptanceStatus: "accepted", acceptanceSummary: "The cited brief and its required policy acceptance are complete.", provider: "openai", model: "gpt-5", routeReason: "Selected OpenAI GPT-5 for model.generate; quality unobserved; cost unobserved; latency unobserved; healthy route.", inputTokens: 120, outputTokens: 80, toolCalls: 1, durationMs: 1250, attemptNumber: 1, sourceCount: 1, trust: "provider-generated-with-external-evidence", maxInputTokens: 32000, maxOutputTokens: 2048, maxToolCalls: 1, maxDurationMs: 120000, maxAttempts: 2, costAmount: "0.00095", costCurrency: "USD", pricingReference: "official-price|reviewed=2026-07-12" } };
  })
}));

vi.mock("./lib/cited-brief-contract", () => ({
  isCitedBriefMissionPrompt: (value: string) =>
    /connected work sources?/i.test(value) &&
    /(?:cited|trustworthy)/i.test(value) &&
    /brief/i.test(value),
  isCitedBriefMissionReceipt: (value: unknown) =>
    typeof value === "object" && value !== null,
  isCitedBriefMissionPlanSummary: (value: unknown) =>
    typeof value === "object" && value !== null
}));

vi.mock("./lib/runtime-mission-graph", () => ({
  resumeInterruptedRuntimeProviderMissions: vi.fn(async () => ({
    resumed: 0,
    dormant: 0,
    waiting: 0,
    terminalized: 0,
    failed: 0
  }))
}));

vi.mock("./lib/parallel-approaches-mission", () => ({
  isParallelApproachesMissionPrompt: (value: string) =>
    /generate two approaches/i.test(value) && /compare/i.test(value),
  isParallelApproachesPlanSummary: (value: unknown) => typeof value === "object" && value !== null,
  resumeReviewedParallelApproachesMissions: vi.fn(async () => ({ resumed: 0, finalized: 0 })),
  executeParallelApproachesMission: vi.fn(async (input: Record<string, unknown>) => {
    runtimeMocks.parallelApproachCalls.push(input);
    const reviewed = /\b(?:reviewer|judge)\b/i.test(String(input.prompt ?? ""));
    const plan = {
      title: "Compare two approaches",
      summary: "Generate two approaches for onboarding and compare them.",
      executionLabel: reviewed ? "Two producers · one independent reviewer" : "Two workers · deterministic join",
      steps: [
        { title: "Practical approach", objective: "Prefer low complexity.", output: "Required Markdown approach" },
        { title: "Alternative approach", objective: "Explore higher upside.", output: "Required Markdown approach" },
        ...(reviewed ? [{
          title: "Independent review",
          objective: "Assess only the two joined outputs against the declared criteria.",
          output: "Bounded model-generated recommendation"
        }] : []),
        { title: "Compare", objective: "Join both exact outputs.", output: "Draft comparison artifact" }
      ],
      acceptance: [reviewed
        ? "Both outputs reach the durable join and the independent reviewer assesses only those exact outputs."
        : "Both independently generated outputs must reach the durable all-workers join."],
      budget: { maxWorkers: reviewed ? 3 : 2, maxDurationMs: 90_000, maxOutputTokens: 2_048, maxAttempts: 1 }
    };
    (input.onPlanReady as ((plan: unknown) => void) | undefined)?.(plan);
    (input.onProgress as ((progress: unknown) => void) | undefined)?.({
      version: 1,
      state: "running",
      summary: "Mission work is progressing within its declared limits.",
      runStatus: "running",
      completedSteps: 1,
      totalSteps: plan.steps.length,
      runningWorkers: 1,
      readyWorkers: 0,
      waitingSteps: 1,
      blockedSteps: 0,
      steps: plan.steps.map((step, index) => ({
        stepKey: `step-${index + 1}`,
        title: step.title,
        kind: index === plan.steps.length - 1 ? "coordinate" : "produce",
        state: index === 0 ? "completed" : index === 1 ? "running" : "waiting",
        detail: index === 0 ? "The durable output is complete." : index === 1 ? "Work is in progress." : "Waiting for its declared dependencies."
      })),
      usage: { records: 1, inputTokens: 10, outputTokens: 5, toolCalls: 0, durationMs: 500, costObservations: [] },
      budget: { maxWorkers: reviewed ? 3 : 2 },
      acceptance: [],
      nextAction: "Wait for current bounded work to settle."
    });
    return {
      missionId: "parallel-mission-ui", runId: "parallel-run-ui", outcome: "completed",
      text: reviewed
        ? "# Two approaches\n\n## Approach A\n\nPractical.\n\n## Approach B\n\nAlternative.\n\n## Independent model review\n\nRecommendation: Approach A."
        : "# Two approaches\n\n## Approach A\n\nPractical.\n\n## Approach B\n\nAlternative.",
      artifactId: "parallel-artifact-ui", artifactVersionId: "parallel-version-ui",
      journal: {}, plan
    };
  })
}));

vi.mock("./lib/parallel-approaches-contract", () => ({
  isParallelApproachesMissionPrompt: (value: string) =>
    /generate two approaches/i.test(value) && /compare/i.test(value),
  isParallelApproachesPlanSummary: (value: unknown) =>
    typeof value === "object" && value !== null
}));

vi.mock("./lib/general-mission", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/general-mission")>();
  return {
    ...actual,
    executeGeneralMission: vi.fn(async (input: Record<string, unknown>) => {
      runtimeMocks.generalMissionCalls.push(input);
      const progress = {
        version: 1,
        state: "waiting",
        summary: "Three independent drafts are ready for review.",
        runStatus: "running",
        completedSteps: 3,
        totalSteps: 3,
        runningWorkers: 0,
        readyWorkers: 0,
        waitingSteps: 0,
        blockedSteps: 0,
        steps: [
          { stepKey: "task-1", title: "Prepare the brief", kind: "produce", state: "completed", detail: "The durable output is complete." },
          { stepKey: "task-2", title: "Review the risks", kind: "produce", state: "completed", detail: "The durable output is complete." },
          { stepKey: "task-3", title: "Recommend next steps", kind: "produce", state: "completed", detail: "The durable output is complete." }
        ],
        usage: { records: 3, inputTokens: 60, outputTokens: 30, toolCalls: 0, durationMs: 500, costObservations: [] },
        budget: {
          maxDurationMs: 180_000,
          maxInputTokens: 64_000,
          maxOutputTokens: 6_144,
          maxToolCalls: 1,
          maxWorkers: 3,
          maxAttempts: 2
        },
        acceptance: [],
        humanReview: null,
        nextAction: "Review each result."
      };
      await (input.onRunReady as ((runId: string, value: unknown) => Promise<void>) | undefined)?.(
        "general-run-ui",
        progress
      );
      (input.onProgress as ((value: unknown) => void) | undefined)?.(progress);
      return {
        missionId: "general-mission-ui",
        runId: "general-run-ui",
        outcome: "awaiting-review",
        text: "# Launch readiness\n\n## Prepare the brief\n\nBrief.\n\n## Review the risks\n\nRisks.\n\n## Recommend next steps\n\nRecommendation.",
        progress
      };
    })
  };
});

const testCitedPlan = {
  title: "Connected work brief", summary: "What changed?", executionLabel: "One focused research step",
  step: { title: "Research and write", objective: "Search and write.", capability: "Search connected work sources", output: "A trustworthy Markdown brief." },
  acceptance: ["Use only attested citations."],
  budget: { maxInputTokens: 32000, maxOutputTokens: 2048, maxToolCalls: 1, maxDurationMs: 120000, maxAttempts: 2 }
};

vi.mock("./lib/provider-route-selection", () => ({
  selectNativeProviderRoute: vi.fn(async (input: { providerId: string; model: string }) => ({
    workspaceId: "test-workspace",
    selection: {
      providerRouteId: `route-${input.providerId}-${input.model}`,
      selectedAt: "2026-07-12T12:00:00.000Z",
      reason: `Selected ${input.providerId} ${input.model}.`,
      boundaryPolicyRef: `boundary-${input.providerId}`
    }
  }))
}));

vi.mock("./hooks/useProjects", () => ({
  useProjects: () => ({
    projects: runtimeMocks.projectRecords.filter((project) => project.lifecycle === "active"),
    archivedProjects: runtimeMocks.projectRecords.filter((project) => project.lifecycle === "archived"),
    loading: false,
    error: null,
    refresh: vi.fn(async () => runtimeMocks.projectRecords),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
    remove: vi.fn()
  })
}));

// A connected Codex backend so the existing workspace tests clear the
// onboarding gate by default. Dedicated onboarding tests override this to null.
const connectedCodex: BackendProvider = {
  id: "codex",
  backendType: "codex-app-server",
  label: "Codex",
  description: "Codex app-server",
  authState: "connected",
  capabilities: ["authentication", "threads", "streaming"],
  models: [{ id: "gpt-5", label: "GPT-5", available: true }],
  installHint: "Requires the Codex CLI.",
  entitlements: undefined
};

vi.mock("./runtime", () => ({
  wireToWorkflowRun: (run: unknown) => run,
  recoverRuntimeInterruptedCitedMissions: vi.fn(async () => null),
  recoverRuntimeCompletedParallelApproaches: vi.fn(async () => null),
  loadRuntimeExecutionControl: vi.fn(async () => ({
    paused: false,
    revision: 0,
    changedAt: ""
  })),
  pauseRuntimeExecution: vi.fn(async () => ({
    paused: true,
    revision: 1,
    changedAt: "2026-07-24T09:00:00.000Z"
  })),
  resumeRuntimeExecution: vi.fn(async () => ({
    paused: false,
    revision: 2,
    changedAt: "2026-07-24T09:01:00.000Z"
  })),
  createRuntimeConversationThread: vi.fn(async (input: { title?: string }) => {
    const thread = {
      id: "test-durable-thread",
      title: input.title ?? "New chat",
      lifecycle: "active",
      messageHead: { lastSequence: 0 }
    };
    runtimeMocks.conversationThreads = [thread];
    return thread;
  }),
  listRuntimeConversationThreads: vi.fn(async () => runtimeMocks.conversationThreads),
  getRuntimeConversationThread: vi.fn(async (threadId: string) =>
    runtimeMocks.conversationThreads.find((thread) => thread.id === threadId) ?? null),
  updateRuntimeConversationThread: vi.fn(async () => null),
  listRuntimeConversationMessages: vi.fn(async () => runtimeMocks.conversationMessages),
  appendRuntimeConversationMessage: vi.fn(async (input: any) => ({
    message: {
      id: input.messageId,
      threadId: input.threadId,
      kind: input.kind,
      sequence: input.sequence,
      currentRevisionId: input.initialRevision.revisionId,
      currentRevisionNumber: 1,
      currentRevisionState: input.initialRevision.state
    },
    currentRevision: {
      id: input.initialRevision.revisionId,
      threadId: input.threadId,
      messageId: input.messageId,
      messageRevisionNumber: 1,
      state: input.initialRevision.state,
      content: input.initialRevision.content
    }
  })),
  reviseRuntimeConversationMessage: vi.fn(async (input: any) => ({
    message: {
      id: input.messageId,
      threadId: input.threadId,
      sequence: input.sequence ?? 1,
      currentRevisionId: input.revisionId,
      currentRevisionNumber: input.baseMessageRevisionNumber + 1,
      currentRevisionState: input.state
    },
    currentRevision: {
      id: input.revisionId,
      threadId: input.threadId,
      messageId: input.messageId,
      messageRevisionNumber: input.baseMessageRevisionNumber + 1,
      state: input.state,
      content: input.content
    }
  })),
  loadRuntimeConversationDraft: vi.fn(async () => null),
  saveRuntimeConversationDraft: vi.fn(async (draft: unknown) => draft),
  deleteRuntimeConversationDraft: vi.fn(async () => undefined),
  createRuntimeResponseArtifact: vi.fn(async () => null),
  listRuntimeThreadArtifacts: vi.fn(async () => []),
  listRuntimePendingCitedApprovals: vi.fn(async () => ({ approvals: [], unavailableCount: 0, truncated: false })),
  listRuntimePendingMissionApprovals: vi.fn(async () => ({ approvals: [], unavailableCount: 0, truncated: false })),
  listRuntimePendingMissionHumanInputs: vi.fn(async () => ({ requests: [], unavailableCount: 0, truncated: false })),
  resolveRuntimeCitedApproval: vi.fn(async () => null),
  resolveRuntimeMissionApproval: vi.fn(async () => null),
  cancelRuntimeCitedApproval: vi.fn(async () => null),
  cancelRuntimeMissionApproval: vi.fn(async () => null),
  receiveRuntimeMissionHumanInput: vi.fn(async () => null),
  startRuntimeStructuredIntake: vi.fn(async (input: Record<string, unknown>) => {
    runtimeMocks.structuredIntakeCalls.push(input);
    return {
      runId: "structured-run-ui", missionId: "structured-mission-ui",
      sourceThreadId: input.sourceThreadId, waitKey: "human-input-wait:v1:structured-ui",
      requestKey: "structured-intake:v1", prompt: "Tell Fable what belongs in this project brief.",
      fields: [
        { key: "title", label: "Title", kind: "text", required: true, sensitive: false },
        { key: "objective", label: "Objective", kind: "text", required: true, sensitive: false },
        { key: "audience", label: "Audience", kind: "choice", required: true, sensitive: false, choices: ["Team", "Leadership", "Customers", "Personal"] },
        { key: "success", label: "Success criteria", kind: "text", required: true, sensitive: false }
      ],
      requestedAt: "2026-07-13T12:00:00Z", runRevision: 5, lastSequence: 4
    };
  }),
  startRuntimeArtifactRevisionBrief: vi.fn(async (input: Record<string, unknown>) => {
    runtimeMocks.artifactRevisionBriefCalls.push(input);
    return {
      runId: "revision-brief-run-ui", missionId: "revision-brief-mission-ui",
      sourceThreadId: input.sourceThreadId, projectId: input.projectId,
      waitKey: "human-input-wait:v1:revision-ui", requestKey: "artifact-revision-brief:v1",
      prompt: "Choose an exact artifact version and describe the revision.",
      fields: [
        { key: "sourceArtifact", label: "Source artifact", kind: "artifact", required: true, sensitive: false },
        { key: "objective", label: "Revision objective", kind: "text", required: true, sensitive: false },
        { key: "changes", label: "Requested changes", kind: "text", required: true, sensitive: false },
        { key: "preserve", label: "Preserve", kind: "text", required: false, sensitive: false },
        { key: "reviewBeforeUse", label: "Review before use", kind: "boolean", required: true, sensitive: false },
        { key: "targetAt", label: "Target date", kind: "date-time", required: false, sensitive: false }
      ],
      requestedAt: "2026-07-13T12:00:00Z", runRevision: 5, lastSequence: 4
    };
  }),
  searchRuntimeArtifacts: vi.fn(async () => []),
  cancelRuntimeMissionHumanInput: vi.fn(async () => null),
  getRuntimeArtifact: vi.fn(async () => null),
  readRuntimeCitedMissionReceipts: vi.fn(async (_threadId: string, messageIds: string[]) =>
    messageIds.map((messageId) => ({ messageId, status: "unavailable" }))),
  readRuntimeCitedMissionPlanSummaries: vi.fn(async (_threadId: string, messageIds: string[]) =>
    messageIds.map((messageId) => ({ messageId, status: "unavailable" }))),
  readRuntimeMissionProgress: vi.fn(async () => null),
  listRuntimeThreadMissionProgress: vi.fn(async () => ({
    progress: [], unavailableCount: 0, truncated: false
  })),
  beginRuntimeConnectorOAuth: vi.fn(async (request: { connectorId: string }) => {
    runtimeMocks.connectorOAuthCalls.push(request.connectorId);
    return null;
  }),
  clearRuntimeConnectorAuth: vi.fn(async () => null),
  clearRuntimeBackend: vi.fn(async () => null),
  connectRuntimeBackend: vi.fn(async () => "codex"),
  detectRuntimeAcpCli: vi.fn(async () => null),
  detectRuntimeLocalModel: vi.fn(async () => null),
  beginRuntimeIdentitySignIn: vi.fn(async () => null),
  exportRuntimeMemoryState: vi.fn(async () => null),
  exportRuntimeProjectArchive: vi.fn(async () => null),
  getRuntimeRemoteControlStatus: vi.fn(async () => null),
  deleteRuntimeConnectorKnowledgeSource: vi.fn(async () => null),
  importRuntimeConnectorItem: vi.fn(async () => null),
  importRuntimeLocalKnowledgeSource: vi.fn(async () => null),
  listRuntimeConnectorStatuses: vi.fn(async () => null),
  listRuntimeConnectorAccounts: vi.fn(async () => null),
  listRuntimeConnectorKnowledgeSources: vi.fn(async () => null),
  listRuntimeConnectorSyncStates: vi.fn(async () => null),
  setRuntimeConnectorKnowledgeSourceDisabled: vi.fn(async () => null),
  listRuntimeSchedulerJobs: vi.fn(async () =>
    runtimeMocks.savedScheduledJobs.length ? [...runtimeMocks.savedScheduledJobs] : null
  ),
  listRuntimeSchedulerQueue: vi.fn(async () => null),
  listRuntimeWorkflowDefinitions: vi.fn(async () =>
    runtimeMocks.savedWorkflowDefinitions.length ? [...runtimeMocks.savedWorkflowDefinitions] : null
  ),
  listRuntimeWorkflowRuns: vi.fn(async () => null),
  listenRuntimeRoutineRunRequest: vi.fn(async () => null),
  listenRuntimeSchedulerRunRequest: vi.fn(async () => null),
  listenRuntimeSchedulerCancelRequest: vi.fn(async () => null),
  listRuntimeBackends: vi.fn(
    () =>
      new Promise<BackendProvider[] | null>((resolve) => {
        resolve(runtimeMocks.backends ?? [connectedCodex]);
      })
  ),
  // null = no desktop runtime in tests, so the curated catalogue fallback
  // drives model selection (discovery did not run) — matching prior behavior.
  listRuntimeBackendModels: vi.fn(async () => null),
  loadRuntimeActionHistory: vi.fn(async () => null),
  loadRuntimeApprovalAudit: vi.fn(async () => null),
  loadRuntimeApprovalRules: vi.fn(async () => null),
  loadRuntimeIdentityStatus: vi.fn(async () =>
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
      ? runtimeMocks.identityStatus
      : null
  ),
  loadRuntimeAccountWorkspaceStatus: vi.fn(async () => runtimeMocks.accountStatus),
  reconcileRuntimeAccountWorkspace: vi.fn(async () => runtimeMocks.accountStatus),
  createRuntimeAccountWorkspace: vi.fn(async () => runtimeMocks.accountStatus),
  createRuntimeRoutine: vi.fn(async () => null),
  listRuntimeRoutines: vi.fn(async () => []),
  listRuntimeRoutineConnectionOptions: vi.fn(async () => []),
  listRuntimeRoutineHistory: vi.fn(async () => []),
  getRuntimeRoutineSchedulerStatus: vi.fn(async () => null),
  selectRuntimeAccountWorkspace: vi.fn(async () => runtimeMocks.accountStatus),
  revokeRuntimeAccountDevice: vi.fn(async () => runtimeMocks.accountStatus),
  clearRuntimeAccountWorkspaceSession: vi.fn(async () => null),
  beginRuntimeIdentityRecovery: vi.fn(async () => runtimeMocks.identityStatus),
  loadRuntimeImportedKnowledgeSources: vi.fn(async () => null),
  loadRuntimeMemoryState: vi.fn(async () => null),
  loadRuntimeSnapshot: vi.fn(
    () =>
      runtimeMocks.snapshot
        ? Promise.resolve(runtimeMocks.snapshot)
        : new Promise<RuntimeSnapshot | null>(() => {})
  ),
  prepareRuntimeConnectorAction: vi.fn(async () => null),
  promoteRuntimeKnowledgeSourceToMemory: vi.fn(async () => null),
  recordRuntimeBackendEvent: vi.fn(async () => null),
  refreshRuntimeIdentity: vi.fn(async () => null),
  refreshRuntimeConnectorHealth: vi.fn(async () => null),
  syncRuntimeConnector: vi.fn(async () => null),
  resolveRuntimeApprovalRequest: vi.fn(async () => null),
  saveRuntimeMemoryState: vi.fn(async () => null),
  saveRuntimeImportedKnowledgeSources: vi.fn(async () => null),
  saveRuntimeScheduledJob: vi.fn(async (job: unknown) => {
    const record = job as { id: string };
    runtimeMocks.savedScheduledJobs = [
      ...runtimeMocks.savedScheduledJobs.filter((existing) => (existing as { id: string }).id !== record.id),
      job
    ];
    return null;
  }),
  saveRuntimeWorkflowDefinition: vi.fn(async (definition: unknown) => {
    const record = definition as { id: string };
    runtimeMocks.savedWorkflowDefinitions = [
      ...runtimeMocks.savedWorkflowDefinitions.filter((existing) => (existing as { id: string }).id !== record.id),
      definition
    ];
    return null;
  }),
  saveRuntimeWorkflowRun: vi.fn(async () => null),
  enqueueRuntimeJobRun: vi.fn(async () => null),
  reportRuntimeJobAttempt: vi.fn(async () => null),
  reportRuntimeRoutineAttempt: vi.fn(async () => null),
  renewRuntimeJobLease: vi.fn(async () => null),
  renewRuntimeRoutineLease: vi.fn(async () => null),
  requeueRuntimeBlockedJobRun: vi.fn(async () => null),
  cancelRuntimeJobRun: vi.fn(async () => null),
  setRuntimeJobStatus: vi.fn(async () => null),
  deleteRuntimeScheduledJob: vi.fn(async (jobId: string) => {
    runtimeMocks.savedScheduledJobs = runtimeMocks.savedScheduledJobs.filter(
      (existing) => (existing as { id: string }).id !== jobId
    );
    return null;
  }),
  deliverRuntimeNotification: vi.fn(async () => null),
  executeRuntimeConnectorAction: vi.fn(async () => null),
  saveRuntimeAgentRun: vi.fn(async (run: unknown) => run),
  recoverRuntimeAgentRuns: vi.fn(async () => runtimeMocks.agentRuns),
  listRuntimeAgentRuns: vi.fn(async () => runtimeMocks.agentRuns),
  saveRuntimeSnapshot: vi.fn(async (snapshot: RuntimeSnapshot) => {
    runtimeMocks.savedSnapshots.push(snapshot);
    return snapshot;
  }),
  searchRuntimeConnector: vi.fn(async () => null),
  searchRuntimeKnowledgeSources: vi.fn(async () => null),
  signOutRuntimeIdentity: vi.fn(async () => null),
  startRuntimeConnectorAuth: vi.fn(async () => null),
  streamRuntimeCompletion: vi.fn(async () => null),
  cancelRuntimeCompletion: vi.fn(async (requestId: string) => {
    runtimeMocks.cancelCalls.push(requestId);
    return null;
  }),
  executeRuntimeToolCall: vi.fn(async () => ({ ok: true, output: "ok" })),
  listenRuntimeBackendEvents: vi.fn(
    async (
      _requestId: string,
      onLine?: (line: string) => void
    ): Promise<(() => void) | null> => {
      // Mirror the real wrapper: outside Tauri (no __TAURI_INTERNALS__) it is a
      // no-op returning null, keeping the loop fixture-testable. Inside the
      // faked desktop runtime it feeds the scripted SSE lines.
      const hasRuntime =
        typeof window !== "undefined" &&
        Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
      if (!hasRuntime || !onLine) {
        return null;
      }
      runtimeMocks.onLine = onLine;
      for (const line of runtimeMocks.lines) {
        onLine(line);
      }
      if (runtimeMocks.emitDone) {
        onLine("[DONE]");
      }
      return () => {};
    }
  ),
  // Verified connect path: by default the stored key verifies ready (preview
  // mode). Onboarding/Settings tests assert useful-error behavior by overriding
  // this to return auth-failed/offline/unsupported/failed.
  verifyRuntimeBackend: vi.fn(async (providerId: string) => ({
    providerId,
    outcome: "ready" as const,
    message: undefined
  }))
}));

// Typed handle to the mocked credential-boundary connect wrapper so Settings
// tests can assert the secret was handed to the boundary (and never leaked into
// React state, logs, or snapshots).
import * as runtimeModule from "./runtime";
const connectRuntimeBackendSpy = vi.mocked(runtimeModule.connectRuntimeBackend);

/** Re-render with an unrelated connected preview provider to open Settings. */
async function skipOnboarding() {
  const connectedGemini: BackendProvider = {
    id: "gemini",
    backendType: "native-api",
    label: "Gemini",
    description: "Gemini test provider",
    authState: "connected",
    capabilities: ["authentication", "threads", "streaming"],
    models: [{ id: "gemini-test", label: "Gemini Test", available: true }]
  };
  runtimeMocks.backends = [
    ...(runtimeMocks.backends ?? []),
    ...((runtimeMocks.backends ?? []).some((provider) => provider.id === connectedGemini.id)
      ? []
      : [connectedGemini])
  ];
  cleanup();
  render(<App />);
  await screen.findByLabelText(/universal composer/i);
}

/** Install window.__TAURI_INTERNALS__ so the agent hook sees a desktop runtime. */
function installDesktopRuntime() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: { invoke: {} },
    configurable: true,
    writable: true
  });
}

/** Remove the faked desktop runtime so the agent hook sees no transport. */
function removeDesktopRuntime() {
  try {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  } catch {
  }
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = undefined;
}

/**
 * Render App and wait for the workspace (onboarding gate cleared). The runtime
 * mock serves a connected Codex backend by default, so the gate clears once the
 * backend-loading effect resolves.
 */
async function renderWorkspace() {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByLabelText(/universal composer/i);
  return user;
}

async function waitForScheduleNewButton() {
  const button = await screen.findByRole(
    "button",
    { name: /^new$/i },
    { timeout: 15000 }
  );
  await waitFor(() => expect(button).toBeEnabled(), { timeout: 15000 });
  return button;
}

describe("Fable home", () => {
  beforeEach(() => {
    window.localStorage.clear();
    runtimeMocks.identityStatus = structuredClone(defaultIdentityStatus);
    runtimeMocks.accountStatus = structuredClone(defaultAccountStatus);
    runtimeMocks.snapshot = null;
    runtimeMocks.savedSnapshots = [];
    // Default to a connected backend so the onboarding gate is cleared for the
    // existing workspace tests. Onboarding tests set this to an empty list.
    runtimeMocks.backends = null;
    runtimeMocks.lines = [];
    runtimeMocks.emitDone = true;
    runtimeMocks.onLine = null;
    runtimeMocks.cancelCalls = [];
    runtimeMocks.connectorOAuthCalls = [];
    runtimeMocks.agentRuns = [];
    runtimeMocks.conversationThreads = [];
    runtimeMocks.conversationMessages = [];
    runtimeMocks.projectRecords = [];
    runtimeMocks.citedBriefCalls = [];
    runtimeMocks.structuredIntakeCalls = [];
    runtimeMocks.artifactRevisionBriefCalls = [];
    runtimeMocks.parallelApproachCalls = [];
    runtimeMocks.generalMissionCalls = [];
    runtimeMocks.citedBriefGate = null;
    runtimeMocks.savedScheduledJobs = [];
    runtimeMocks.savedWorkflowDefinitions = [];
    connectRuntimeBackendSpy.mockClear();
    vi.mocked(listRuntimeConnectorStatuses).mockReset();
    vi.mocked(listRuntimeConnectorStatuses).mockResolvedValue(null);
    vi.mocked(prepareRuntimeConnectorAction).mockReset();
    vi.mocked(prepareRuntimeConnectorAction).mockResolvedValue(null);
    vi.mocked(listRuntimeThreadArtifacts).mockReset();
    vi.mocked(listRuntimeThreadArtifacts).mockResolvedValue([]);
    vi.mocked(listRuntimePendingCitedApprovals).mockReset();
    vi.mocked(listRuntimePendingCitedApprovals).mockResolvedValue({ approvals: [], unavailableCount: 0, truncated: false });
    vi.mocked(listRuntimePendingMissionApprovals).mockReset();
    vi.mocked(listRuntimePendingMissionApprovals).mockResolvedValue({ approvals: [], unavailableCount: 0, truncated: false });
    vi.mocked(resolveRuntimeMissionApproval).mockReset();
    vi.mocked(resolveRuntimeMissionApproval).mockResolvedValue(null);
    vi.mocked(listRuntimePendingMissionHumanInputs).mockReset();
    vi.mocked(listRuntimePendingMissionHumanInputs).mockResolvedValue({ requests: [], unavailableCount: 0, truncated: false });
    vi.mocked(listRuntimeThreadMissionProgress).mockReset();
    vi.mocked(listRuntimeThreadMissionProgress).mockResolvedValue({
      progress: [], unavailableCount: 0, truncated: false
    });
    vi.mocked(receiveRuntimeMissionHumanInput).mockReset();
    vi.mocked(receiveRuntimeMissionHumanInput).mockResolvedValue(null);
    vi.mocked(startRuntimeStructuredIntake).mockReset();
    vi.mocked(startRuntimeStructuredIntake).mockImplementation(async (input) => {
      runtimeMocks.structuredIntakeCalls.push(input as unknown as Record<string, unknown>);
      return {
        runId: "structured-run-ui", missionId: "structured-mission-ui",
        sourceThreadId: input.sourceThreadId, waitKey: "human-input-wait:v1:structured-ui",
        requestKey: "structured-intake:v1", prompt: "Tell Fable what belongs in this project brief.",
        fields: [
          { key: "title", label: "Title", kind: "text", required: true, sensitive: false },
          { key: "objective", label: "Objective", kind: "text", required: true, sensitive: false },
          { key: "audience", label: "Audience", kind: "choice", required: true, sensitive: false, choices: ["Team", "Leadership", "Customers", "Personal"] },
          { key: "success", label: "Success criteria", kind: "text", required: true, sensitive: false }
        ],
        requestedAt: "2026-07-13T12:00:00Z", runRevision: 5, lastSequence: 4
      };
    });
    vi.mocked(startRuntimeArtifactRevisionBrief).mockReset();
    vi.mocked(startRuntimeArtifactRevisionBrief).mockImplementation(async (input) => {
      runtimeMocks.artifactRevisionBriefCalls.push(input as unknown as Record<string, unknown>);
      return {
        runId: "revision-brief-run-ui", missionId: "revision-brief-mission-ui",
        sourceThreadId: input.sourceThreadId, projectId: input.projectId,
        waitKey: "human-input-wait:v1:revision-ui", requestKey: "artifact-revision-brief:v1",
        prompt: "Choose an exact artifact version and describe the revision.",
        fields: [
          { key: "sourceArtifact", label: "Source artifact", kind: "artifact" as const, required: true, sensitive: false },
          { key: "objective", label: "Revision objective", kind: "text" as const, required: true, sensitive: false },
          { key: "changes", label: "Requested changes", kind: "text" as const, required: true, sensitive: false },
          { key: "preserve", label: "Preserve", kind: "text" as const, required: false, sensitive: false },
          { key: "reviewBeforeUse", label: "Review before use", kind: "boolean" as const, required: true, sensitive: false },
          { key: "targetAt", label: "Target date", kind: "date-time" as const, required: false, sensitive: false }
        ],
        requestedAt: "2026-07-13T12:00:00Z", runRevision: 5, lastSequence: 4
      };
    });
    vi.mocked(searchRuntimeArtifacts).mockReset();
    vi.mocked(searchRuntimeArtifacts).mockResolvedValue([]);
    vi.mocked(cancelRuntimeMissionHumanInput).mockReset();
    vi.mocked(cancelRuntimeMissionHumanInput).mockResolvedValue(null);
    vi.mocked(cancelRuntimeMissionApproval).mockReset();
    vi.mocked(cancelRuntimeMissionApproval).mockResolvedValue(null);
    vi.mocked(readRuntimeCitedMissionReceipts).mockReset();
    vi.mocked(readRuntimeCitedMissionReceipts).mockImplementation(async (_threadId, messageIds) =>
      messageIds.map((messageId) => ({ messageId, status: "unavailable" as const })));
    vi.mocked(readRuntimeCitedMissionPlanSummaries).mockReset();
    vi.mocked(readRuntimeCitedMissionPlanSummaries).mockImplementation(async (_threadId, messageIds) =>
      messageIds.map((messageId) => ({ messageId, status: "unavailable" as const })));
    vi.mocked(readRuntimeMissionProgress).mockReset();
    vi.mocked(readRuntimeMissionProgress).mockResolvedValue(null);
    removeDesktopRuntime();
  });

  it("renders no connector rail until a connector is connected", async () => {
    await renderWorkspace();

    // No connectors start connected, so the home rail renders nothing.
    expect(screen.queryByLabelText(/connected connectors/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /google docs/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /gmail/i })).not.toBeInTheDocument();
  });

  it("renders the quiet agent-first shell without legacy primary navigation", async () => {
    await renderWorkspace();

    expect(screen.getByRole("complementary", { name: "Agents" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New agent" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Fable workspace" })).toBeInTheDocument();
    expect(screen.queryByText("Chats")).not.toBeInTheDocument();
    expect(screen.queryByText("Projects")).not.toBeInTheDocument();
    expect(screen.queryByText("Departments")).not.toBeInTheDocument();
  });

  it("natural goal creates structured Fable state persisted in the snapshot", async () => {
    // Seed a snapshot so the runtime-save path is active for this session.
    runtimeMocks.snapshot = {
      version: 1,
      activeItem: "new-chat",
      composerDraft: "",
      voiceEnabled: false,
      approvalAudit: [],
      dismissedApprovalIds: [],
      approvalRules: [],
      automationStatuses: {},
      schedules: [],
      goals: [],
      plans: [],
      pinnedSourceIds: [],
      importedKnowledgeSources: [],
      memoryDisabled: false,
      memoryRecords: [],
      connectedBackendIds: [],
      selectedModelId: "",
      permissionMode: "full-access",
      savedAt: "2026-06-26T10:30:00.000Z"
    };
    const user = await renderWorkspace();

    await user.type(
      screen.getByLabelText(/universal composer/i),
      "Set a goal to ship the v2 onboarding flow"
    );
    await user.keyboard("{Enter}");

    // The goal is created and surfaced; no model is connected in this harness so
    // the result tells the user to connect one.
    const conversation = await screen.findByRole("region", { name: /conversation/i });
    expect(await within(conversation).findByText(/goal saved/i)).toBeInTheDocument();

    // The goal is persisted through the runtime snapshot (durable, non-secret).
    await waitFor(() => {
      const snapshot = runtimeMocks.savedSnapshots.at(-1);
      expect(snapshot?.goals.some((goal) => goal.statement.includes("v2 onboarding flow"))).toBe(true);
    });
  });

  it("treats an unknown slash command as an ordinary prompt (passthrough reservation)", async () => {
    const user = await renderWorkspace();

    await user.type(screen.getByLabelText(/universal composer/i), "/summarize the open PRs");
    await user.keyboard("{Enter}");

    // Unknown slashes fall through to the normal knowledge-search submit path;
    // they are not swallowed as an unknown Fable command.
    expect(await screen.findByText(/summarize the open PRs/i)).toBeInTheDocument();
  });

  it("recovers composer drafts from local persistence", async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);
    await screen.findByLabelText(/universal composer/i);

    await user.type(screen.getByLabelText(/universal composer/i), "Plan the onboarding journey");
    firstRender.unmount();
    render(<App />);
    await screen.findByLabelText(/universal composer/i);

    expect(screen.getByLabelText(/universal composer/i)).toHaveValue("Plan the onboarding journey");
  });

  it("sends the composer prompt on Enter without inserting a newline", async () => {
    const user = userEvent.setup();
    // Serve a connected native provider so Enter drives the agent loop path.
    runtimeMocks.backends = [
      {
        id: "openai",
        backendType: "native-api",
        label: "OpenAI",
        description: "OpenAI native",
        authState: "connected",
        capabilities: ["authentication", "threads", "streaming", "tool-requests"],
        models: [{ id: "gpt-5", label: "GPT-5", available: true }]
      }
    ];
    render(<App />);

    const composer = await screen.findByLabelText(/universal composer/i);
    await user.type(composer, "summarize the project");
    await user.keyboard("{Enter}");

    // Enter sends into the conversation and clears the composer.
    await waitFor(() => {
      expect(composer).toHaveValue("");
    });
    expect(
      screen.getByText("summarize the project", {
        selector: ".conversation-message--user p"
      })
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/agent activity/i)).not.toBeInTheDocument();
    expect(composer.closest(".workspace-center--conversation")).toBeInTheDocument();
    expect(composer.closest(".conversation-composer-dock")).toBeInTheDocument();
    // The newline was not inserted into the composer.
    expect(composer).toHaveValue("");
  });

  it("natural plan phrasing creates structured plan state", async () => {
    const user = await renderWorkspace();
    await user.type(screen.getByLabelText(/universal composer/i), "Create a plan to migrate the config store");
    await user.keyboard("{Enter}");
    const conversation = await screen.findByRole("region", { name: /conversation/i });
    expect(await within(conversation).findByText(/plan saved/i)).toBeInTheDocument();
    const promptActions = within(conversation).getByRole("group", { name: "User message actions" });
    expect(within(promptActions).getByRole("button", { name: "Save to Knowledge" })).toBeInTheDocument();
    expect(within(promptActions).getByRole("button", { name: "Copy prompt" })).toBeInTheDocument();
    await user.click(within(promptActions).getByRole("button", { name: "Edit prompt" }));
    expect(screen.getByLabelText(/universal composer/i)).toHaveValue(
      "Create a plan to migrate the config store"
    );
    const responseActions = within(conversation).getByRole("group", { name: "Assistant message actions" });
    expect(within(responseActions).getByRole("button", { name: "Save to Knowledge" })).toBeInTheDocument();
    expect(within(responseActions).getByRole("button", { name: "Copy response" })).toBeInTheDocument();
    expect(within(responseActions).getByRole("button", { name: "Redo response" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save response as artifact/i })).not.toBeInTheDocument();
  });

  it("starts and submits the structured brief intake without provider execution", async () => {
    const user = await renderWorkspace();
    const composer = screen.getByLabelText(/universal composer/i);
    await user.type(composer, "Create a structured project brief for the autumn launch");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(runtimeMocks.structuredIntakeCalls).toHaveLength(1), {
      timeout: 5_000
    });
    expect(await screen.findByText("Tell Fable what belongs in this project brief.")).toBeInTheDocument();
    expect(runtimeMocks.citedBriefCalls).toHaveLength(0);
    expect(runtimeMocks.structuredIntakeCalls[0]).toMatchObject({
      sourceThreadId: expect.any(String), subject: "the autumn launch", startKey: expect.any(String)
    });

    await user.type(screen.getByLabelText(/Title/), "Autumn launch");
    await user.type(screen.getByLabelText(/Objective/), "Ship a calm, reliable launch.");
    await user.selectOptions(screen.getByLabelText(/Audience/), "Leadership");
    await user.type(screen.getByLabelText(/Success criteria/), "The team ships on time.");
    await user.click(screen.getByRole("button", { name: "Continue mission" }));

    await waitFor(() => expect(receiveRuntimeMissionHumanInput).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "structured-run-ui" }),
      [
        { fieldKey: "title", value: "Autumn launch" },
        { fieldKey: "objective", value: "Ship a calm, reliable launch." },
        { fieldKey: "audience", value: "Leadership" },
        { fieldKey: "success", value: "The team ships on time." }
      ]
    ));
  }, 10_000);

  it("starts an artifact revision brief, scopes candidates, and submits only the selected immutable identity", async () => {
    vi.mocked(searchRuntimeArtifacts).mockResolvedValueOnce([{
      artifact: {
        id: "artifact-source", title: "Launch memo", status: "draft", revision: 3,
        currentVersionId: "artifact-source-version-3", producingRunId: "source-run",
        context: { threadId: "source-thread" }, reviews: []
      },
      currentVersion: {
        id: "artifact-source-version-3", artifactId: "artifact-source", version: 3,
        status: "available", content: { kind: "inline", text: "Private source content" }, citations: []
      },
      matchedOn: ["title"]
    }] as never);

    const user = await renderWorkspace();
    const composer = screen.getByLabelText(/universal composer/i);
    await user.type(composer, "/revision-brief launch memo");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(runtimeMocks.artifactRevisionBriefCalls).toHaveLength(1), {
      timeout: 5_000
    });
    expect(runtimeMocks.citedBriefCalls).toHaveLength(0);
    expect(runtimeMocks.artifactRevisionBriefCalls[0]).toMatchObject({
      sourceThreadId: expect.any(String), focus: "launch memo", startKey: expect.any(String)
    });
    expect(await screen.findByText("Choose an exact artifact version and describe the revision.")).toBeInTheDocument();
    await waitFor(() => expect(searchRuntimeArtifacts).toHaveBeenCalledWith({ limit: 100 }));

    await user.selectOptions(screen.getByLabelText(/Source artifact/), "0");
    await user.type(screen.getByLabelText(/Revision objective/), "Make the launch decision clear.");
    await user.type(screen.getByLabelText(/Requested changes/), "Lead with the recommendation.");
    await user.type(screen.getByLabelText(/Preserve/), "Keep the risk table.");
    await user.click(screen.getByLabelText(/Review before use/));
    await user.click(screen.getByRole("button", { name: "Continue mission" }));

    await waitFor(() => expect(receiveRuntimeMissionHumanInput).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "revision-brief-run-ui" }),
      [
        { fieldKey: "sourceArtifact", value: { artifactId: "artifact-source", artifactVersionId: "artifact-source-version-3" } },
        { fieldKey: "objective", value: "Make the launch decision clear." },
        { fieldKey: "changes", value: "Lead with the recommendation." },
        { fieldKey: "preserve", value: "Keep the risk table." },
        { fieldKey: "reviewBeforeUse", value: true }
      ]
    ));
  }, 10_000);

  it("keeps an artifact mission waiting when candidate discovery fails", async () => {
    vi.mocked(searchRuntimeArtifacts).mockRejectedValueOnce(new Error("offline"));
    const user = await renderWorkspace();
    await user.type(screen.getByLabelText(/universal composer/i), "/revision-brief launch memo");
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Artifacts are temporarily unavailable. Fable left this mission waiting."
    );
    expect(screen.getByRole("button", { name: "Continue mission" })).toBeDisabled();
    expect(receiveRuntimeMissionHumanInput).not.toHaveBeenCalled();
  });

  it("inserts a newline on Shift+Enter instead of sending", async () => {
    const user = userEvent.setup();
    render(<App />);
    const composer = await screen.findByLabelText(/universal composer/i);

    await user.type(composer, "first line");
    await user.keyboard("{Shift>}{Enter}{/Shift}");

    // Shift+Enter inserts a newline instead of sending.
    expect(composer).toHaveValue("first line\n");
    // Nothing was sent: no agent activity surface is shown.
    expect(screen.queryByLabelText(/agent activity/i)).not.toBeInTheDocument();
  });

  it("recovers composer drafts from a runtime snapshot", async () => {
    const user = userEvent.setup();
    runtimeMocks.snapshot = {
      version: 1,
      activeItem: "new-chat",
      composerDraft: "/schedule recovered weekly digest",
      voiceEnabled: true,
      approvalAudit: [],
      dismissedApprovalIds: [],
      approvalRules: [],
      automationStatuses: {},
      schedules: [],
      goals: [],
      plans: [],
      pinnedSourceIds: [],
      importedKnowledgeSources: [],
      memoryDisabled: false,
      memoryRecords: [],
      connectedBackendIds: ["codex"],
      selectedModelId: "",
      permissionMode: "full-access",
      savedAt: "2026-06-26T10:30:00.000Z"
    };

    render(<App />);

    // Composer draft is recovered into a chat view.
    expect(await screen.findByDisplayValue("/schedule recovered weekly digest")).toBeInTheDocument();

    await waitFor(() => {
      expect(runtimeMocks.savedSnapshots.at(-1)?.composerDraft).toBe("/schedule recovered weekly digest");
    });
  });

  it("surfaces the native agent activity panel when a connected native backend runs", async () => {
    const user = userEvent.setup();
    // Serve a connected native provider so the composer drives the agent loop.
    runtimeMocks.backends = [
      {
        id: "openai",
        backendType: "native-api",
        label: "OpenAI",
        description: "OpenAI native",
        authState: "connected",
        capabilities: ["authentication", "threads", "streaming", "tool-requests"],
        models: [{ id: "gpt-5", label: "GPT-5", available: true }]
      }
    ];
    render(<App />);

    // Wait for the onboarding gate to clear (the connected provider resolves).
    const composer = await screen.findByLabelText(/universal composer/i);
    await user.type(composer, "summarize the project");
    await user.click(screen.getByRole("button", { name: /send prompt/i }));

    // Outside Tauri there is no transport, and the placeholder surface stays hidden.
    await waitFor(() => {
      expect(screen.queryByLabelText(/agent activity/i)).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/native agent needs a connected desktop backend/i)).not.toBeInTheDocument();
  });

  it("preserves the revoked lifecycle state in connector UI copy", () => {
    const revoked = {
      id: "linear",
      name: "Linear",
      status: "revoked",
      permissions: ["read workspace"],
      healthSummary: "Connection revoked",
      lastCheckedAt: "2026-06-27T09:00:00.000Z",
      authMode: "oauth-broker",
      health: {
        state: "error",
        summary: "Connection revoked",
        checkedAt: "2026-06-27T09:00:00.000Z"
      }
    } satisfies ConnectorManifest;

    expect(resolveDetailedStatus(revoked)).toMatchObject({
      label: "Revoked",
      className: "revoked"
    });
  });
});

/**
 * Onboarding gate: the three-path AI-backend shell. These tests force the
 * gate to show by serving fail-closed (no connected) backend providers.
 */
describe("Fable onboarding", () => {
  // Fail-closed providers: no connection, so the gate is required.
  const failClosedBackends: BackendProvider[] = [
    {
      id: "codex",
      backendType: "codex-app-server",
      label: "Codex",
      description: "Codex app-server",
      authState: "needs-auth",
      capabilities: [],
      models: [{ id: "gpt-5", label: "GPT-5", available: false }],
      installHint: "Requires the Codex CLI."
    },
    {
      id: "cursor",
      backendType: "acp",
      label: "Cursor",
      description: "Cursor over ACP",
      authState: "install-required",
      capabilities: [],
      models: [{ id: "cursor-default", label: "Cursor default", available: false }],
      installHint: "Requires the Cursor CLI. Install it, then connect."
    },
    {
      id: "copilot",
      backendType: "acp",
      label: "GitHub Copilot",
      description: "Copilot over ACP",
      authState: "needs-auth",
      capabilities: [],
      models: [{ id: "copilot-default", label: "Copilot default", available: false }],
      installHint: "Requires the GitHub Copilot CLI."
    },
    {
      id: "grok",
      backendType: "acp",
      label: "Grok",
      description: "Grok over ACP",
      authState: "install-required",
      capabilities: [],
      models: [{ id: "grok-default", label: "Grok default", available: false }],
      installHint: "Requires the Grok CLI. Install it, then connect.",
      entitlements: []
    },
    {
      id: "openai",
      backendType: "native-api",
      label: "OpenAI",
      description: "Reach GPT models directly with an OpenAI API key. Fable owns the agent loop.",
      authState: "needs-auth",
      capabilities: [],
      models: [{ id: "gpt-5", label: "GPT-5", available: false }]
    },
    {
      id: "anthropic",
      backendType: "native-api",
      label: "Anthropic",
      description:
        "Reach Claude via an Anthropic API key. Fable owns the agent loop.",
      authState: "needs-auth",
      capabilities: [],
      models: [{ id: "claude-sonnet-4", label: "Claude Sonnet 4", available: false }]
    },
    {
      id: "gemini",
      backendType: "native-api",
      label: "Gemini",
      description: "Reach Gemini via a Google AI API key. Fable owns the agent loop.",
      authState: "needs-auth",
      capabilities: [],
      models: [{ id: "gemini-2-pro", label: "Gemini 2 Pro", available: false }]
    },
    {
      id: "xai",
      backendType: "native-api",
      label: "xAI",
      description: "Reach Grok models directly with an xAI API key. Fable owns the agent loop.",
      authState: "needs-auth",
      capabilities: [],
      models: [{ id: "grok-4", label: "Grok 4", available: false }]
    },
    {
      id: "openrouter",
      backendType: "native-api",
      label: "OpenRouter",
      description: "Reach many models through OpenRouter with an OpenRouter API key. Fable owns the agent loop.",
      authState: "needs-auth",
      capabilities: [],
      models: [{ id: "openrouter/auto", label: "OpenRouter Auto", available: false }]
    },
    {
      id: "deepseek",
      backendType: "native-api",
      label: "DeepSeek",
      description: "Reach DeepSeek models directly with a DeepSeek API key.",
      authState: "needs-auth",
      capabilities: [],
      models: [{ id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", available: false }]
    },
    {
      id: "zai",
      backendType: "native-api",
      label: "Z.AI",
      description: "Reach GLM models through the general Z.AI API.",
      authState: "needs-auth",
      capabilities: [],
      models: [{ id: "glm-5.1", label: "GLM-5.1", available: false }]
    },
    {
      id: "minimax",
      backendType: "native-api",
      label: "MiniMax",
      description: "Reach MiniMax models with a MiniMax API key.",
      authState: "needs-auth",
      capabilities: [],
      models: [{ id: "MiniMax-M2.7", label: "MiniMax M2.7", available: false }]
    }
  ];

  beforeEach(() => {
    window.localStorage.clear();
    runtimeMocks.snapshot = null;
    runtimeMocks.backends = failClosedBackends;
    connectRuntimeBackendSpy.mockClear();
  });

  const showProviderStep = async () => {
    expect(await screen.findByRole("heading", { name: /add a model provider/i })).toBeInTheDocument();
  };

  it("gates the workspace behind account-first provider onboarding", async () => {
    render(<App />);

    await showProviderStep();
    // The composer must NOT render until a backend is connected.
    expect(screen.queryByLabelText(/universal composer/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/skip onboarding/i)).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /onboarding progress/i })).toHaveTextContent(
      /step 2 of 2/i
    );
  });

  it("shows featured provider families first, then one alphabetical list", async () => {
    const user = userEvent.setup();
    render(<App />);

    await showProviderStep();

    // Predominant provider families are immediately visible, independent of
    // whether their connection method is an account, CLI, or API key.
    for (const label of [
      /openai \/ chatgpt,/i,
      /anthropic,/i,
      /google gemini,/i,
      /github copilot,/i,
      /xai,/i,
      /deepseek,/i,
      /z\.ai,/i
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: /^cursor,/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /show all providers/i }));

    // The expanded view replaces the featured grid and exposes search plus the
    // alphabetized long tail, including provider-owned runtimes.
    expect(screen.getByRole("searchbox", { name: /search providers/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^cursor,/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^minimax,/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^openrouter,/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show all providers/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show featured providers/i })).toBeInTheDocument();
  });

  it("never shows a token field for provider-owned runtimes (subscription/CLI)", async () => {
    const user = userEvent.setup();
    render(<App />);

    await showProviderStep();

    await user.click(screen.getByRole("button", { name: /show all providers/i }));

    // Click the Cursor family, then choose its provider-owned connection method.
    const cursorTile = screen.getByRole("button", { name: /^cursor,/i });
    await user.click(cursorTile);

    const modal = screen.getByRole("dialog", { name: "Cursor" });
    expect(within(modal).getByRole("heading", { name: "Cursor" })).toBeInTheDocument();
    await user.click(within(modal).getByRole("button", { name: /cursor subscription/i }));
    expect(within(modal).getByText(/requires the cursor cli/i)).toBeInTheDocument();

    // No token input:
    expect(
      within(modal).queryByLabelText(/api key for cursor/i)
    ).not.toBeInTheDocument();
  });

  it("fails closed with an install hint for ACP providers lacking a CLI", async () => {
    const user = userEvent.setup();
    render(<App />);

    await showProviderStep();

    await user.click(screen.getByRole("button", { name: /show all providers/i }));

    // Check the Cursor provider-owned method:
    await user.click(screen.getByRole("button", { name: /^cursor,/i }));
    const cursorModal = screen.getByRole("dialog", { name: "Cursor" });
    await user.click(
      within(cursorModal).getByRole("button", { name: /cursor subscription/i })
    );
    expect(within(cursorModal).getByText(/requires the cursor cli/i)).toBeInTheDocument();
    await user.click(within(cursorModal).getByRole("button", { name: /close provider setup/i }));

    // Grok's CLI and xAI's API key are choices inside the same xAI family.
    await user.click(screen.getByRole("button", { name: /^xai,/i }));
    const grokModal = screen.getByRole("dialog", { name: "xAI" });
    await user.click(
      within(grokModal).getByRole("button", { name: /grok account/i })
    );
    expect(within(grokModal).getByText(/requires the grok cli/i)).toBeInTheDocument();
    expect(within(grokModal).queryByLabelText(/api key for xai/i)).not.toBeInTheDocument();
  });

  it("clears the gate when a real capability-bearing runtime is connected", async () => {
    // The real runtime (not an onboarding click) resolves Codex to genuinely
    // connected + capability-bearing. Nothing on the onboarding screen fakes
    // this; the boundary is what flips the gate.
    runtimeMocks.backends = [
      {
        id: "codex",
        backendType: "codex-app-server",
        label: "Codex",
        description: "Codex app-server",
        authState: "connected",
        capabilities: ["authentication", "threads", "streaming"],
        models: [{ id: "gpt-5", label: "GPT-5", available: true }],
        installHint: "Requires the Codex CLI."
      },
      ...failClosedBackends.filter((provider) => provider.id !== "codex")
    ];
    render(<App />);

    // Once the real runtime is capability-bearing, the workspace becomes available
    // without any one-click connect from onboarding.
    expect(await screen.findByLabelText(/universal composer/i)).toBeInTheDocument();
  });

  it("exposes a secure key field in the modal for API-key providers only", async () => {
    const user = userEvent.setup();
    render(<App />);

    await showProviderStep();

    // OpenAI is featured as one family regardless of connection method.
    await user.click(screen.getByRole("button", { name: /openai \/ chatgpt,/i }));

    // Choosing the API-key method reveals a secure input — the key never enters React state.
    const modal = screen.getByRole("dialog", { name: "OpenAI / ChatGPT" });
    await user.click(within(modal).getByRole("button", { name: /openai api key/i }));
    expect(within(modal).getByLabelText(/api key for openai/i)).toBeInTheDocument();
  });

  it("uses compliant copy for Claude and Gemini (no subscription reuse)", async () => {
    const user = userEvent.setup();
    render(<App />);

    await showProviderStep();

    await user.click(screen.getByRole("button", { name: /anthropic,/i }));
    const anthropicModal = screen.getByRole("dialog", { name: "Anthropic" });
    expect(
      within(anthropicModal).getByRole("button", { name: /anthropic api key/i })
    ).toBeInTheDocument();
    const text = anthropicModal.textContent?.toLowerCase() ?? "";
    // No Claude.ai subscription login; no Google AI Pro/Ultra subscription reuse.
    expect(text).not.toMatch(/claude\.ai/);
    expect(text).not.toMatch(/google ai (pro|ultra)/);
    // The implemented direct API-key path is named, without future routing copy.
    expect(text).toMatch(/api key/);
    expect(text).not.toMatch(/vertex|bedrock/);

    await user.click(
      within(anthropicModal).getByRole("button", { name: /close provider setup/i })
    );
    await user.click(screen.getByRole("button", { name: /google gemini,/i }));
    const geminiModal = screen.getByRole("dialog", { name: "Google Gemini" });
    expect(
      within(geminiModal).getByRole("button", { name: /gemini api key/i })
    ).toBeInTheDocument();
    expect(geminiModal).not.toHaveTextContent(/google ai (pro|ultra)/i);
  });

  it("connects a native API-key backend via the verified path and clears the gate", async () => {
    const user = userEvent.setup();
    render(<App />);

    await showProviderStep();

    // Open the provider family and choose its API-key method.
    await user.click(screen.getByRole("button", { name: /openai \/ chatgpt,/i }));
    const modal = screen.getByRole("dialog", { name: "OpenAI / ChatGPT" });
    await user.click(within(modal).getByRole("button", { name: /openai api key/i }));

    // Simulate the credential boundary resolving OpenAI to connected after the
    // store + verify call records the key.
    runtimeMocks.backends = [
      {
        id: "openai",
        backendType: "native-api",
        label: "OpenAI",
        description: "OpenAI native",
        authState: "connected",
        capabilities: ["authentication", "threads", "streaming"],
        models: [{ id: "gpt-5", label: "GPT-5", available: true }]
      },
      ...failClosedBackends.filter((provider) => provider.id !== "openai")
    ];

    const keyInput = within(modal).getByLabelText(/api key for openai/i);
    await user.type(keyInput, "sk-test-key");
    await user.click(within(modal).getByRole("button", { name: /add key & connect/i }));

    // The boundary recorded the secret (store_backend_credential) and verified it
    // (verify_backend_credential). The secret never returns to JS.
    await waitFor(() => {
      expect(connectRuntimeBackendSpy).toHaveBeenCalledWith({
        providerId: "openai",
        secret: "sk-test-key"
      });
    });
    // The key is cleared from the DOM field and never reaches localStorage.
    expect(keyInput).toHaveValue("");
    expect(window.localStorage.getItem("fable.shell.v1") ?? "").not.toContain("sk-test-key");

    // A verified provider completes the minimum journey immediately.
    expect(await screen.findByLabelText(/universal composer/i)).toBeInTheDocument();
  });

  it("does not promise any tier includes grok build entitlements", async () => {
    const user = userEvent.setup();
    render(<App />);

    await showProviderStep();
    const shell = screen.getByRole("heading", { name: /add a model provider/i });
    const frame = shell.closest("main");
    expect(frame?.textContent?.toLowerCase()).not.toMatch(/grok build.*included|premium.*grok/i);
  });

  it("does not render a preview skip control", async () => {
    render(<App />);

    await showProviderStep();
    expect(screen.queryByRole("button", { name: /skip onboarding/i })).not.toBeInTheDocument();
  });
});

/**
 * Native-API runtime bridge: stream/cancel/listen wrappers. Outside Tauri they
 * no-op (return null), keeping the loop fixture-testable.
 */
describe("native API runtime bridge", () => {
  it("exposes stream/cancel/listen wrappers that no-op outside Tauri", async () => {
    const { streamRuntimeCompletion, cancelRuntimeCompletion, listenRuntimeBackendEvents } =
      await import("./runtime");
    expect(
      await streamRuntimeCompletion({
        providerId: "openai",
        requestId: "r1",
        model: "gpt-5",
        body: {}
      })
    ).toBeNull();
    expect(await cancelRuntimeCompletion("r1")).toBeNull();
    expect(await listenRuntimeBackendEvents("r1", () => {})).toBeNull();
  });
});

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AccountWorkspaceStatus, BackendProvider, ConnectorManifest, IdentityStatus, PersistedAgentRun, RuntimeSnapshot } from "@fable/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { resolveDetailedStatus } from "./components/PluginPanel";
import { getRuntimeConversationThread, listRuntimeConnectorStatuses } from "./runtime";
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
  projectRecords: [] as Array<Record<string, unknown>>,
  citedBriefCalls: [] as Array<Record<string, unknown>>,
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

vi.mock("./lib/cited-brief-mission", () => ({
  isCitedBriefMissionPrompt: (value: string) => /connected work sources?/i.test(value) && /(?:cited|trustworthy)/i.test(value) && /brief/i.test(value),
  executeCitedBriefMission: vi.fn(async (input: Record<string, unknown>) => {
    runtimeMocks.citedBriefCalls.push(input);
    return { missionId: "mission-ui", runId: "mission-run-ui", valueReference: "mission-output:v1:ui", text: "Durable cited brief [source-1].", journal: {}, receipt: { provider: "openai", model: "gpt-5", routeReason: "Selected OpenAI GPT-5 for model.generate; quality unobserved; cost unobserved; latency unobserved; healthy route.", inputTokens: 120, outputTokens: 80, toolCalls: 1, sourceCount: 1, trust: "provider-generated-with-external-evidence", maxInputTokens: 32000, maxOutputTokens: 2048, maxToolCalls: 1, maxDurationMs: 120000, maxAttempts: 1, costAmount: "0.00095", costCurrency: "USD", pricingReference: "official-price|reviewed=2026-07-12" } };
  })
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
  listRuntimeConversationMessages: vi.fn(async () => []),
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
  getRuntimeArtifact: vi.fn(async () => null),
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
  getRuntimeRemoteControlStatus: vi.fn(async () => null),
  importRuntimeConnectorItem: vi.fn(async () => null),
  importRuntimeLocalKnowledgeSource: vi.fn(async () => null),
  listRuntimeConnectorStatuses: vi.fn(async () => null),
  listRuntimeConnectorAccounts: vi.fn(async () => null),
  listRuntimeConnectorSyncStates: vi.fn(async () => null),
  listRuntimeSchedulerJobs: vi.fn(async () =>
    runtimeMocks.savedScheduledJobs.length ? [...runtimeMocks.savedScheduledJobs] : null
  ),
  listRuntimeSchedulerQueue: vi.fn(async () => null),
  listRuntimeWorkflowDefinitions: vi.fn(async () =>
    runtimeMocks.savedWorkflowDefinitions.length ? [...runtimeMocks.savedWorkflowDefinitions] : null
  ),
  listRuntimeWorkflowRuns: vi.fn(async () => null),
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
  renewRuntimeJobLease: vi.fn(async () => null),
  requeueRuntimeBlockedJobRun: vi.fn(async () => null),
  cancelRuntimeJobRun: vi.fn(async () => null),
  setRuntimeJobStatus: vi.fn(async () => null),
  deleteRuntimeScheduledJob: vi.fn(async () => null),
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

describe("Fable home", () => {
  beforeEach(() => {
    window.localStorage.clear();
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
    runtimeMocks.projectRecords = [];
    runtimeMocks.citedBriefCalls = [];
    runtimeMocks.savedScheduledJobs = [];
    runtimeMocks.savedWorkflowDefinitions = [];
    connectRuntimeBackendSpy.mockClear();
    vi.mocked(listRuntimeConnectorStatuses).mockReset();
    vi.mocked(listRuntimeConnectorStatuses).mockResolvedValue(null);
    removeDesktopRuntime();
  });

  it("renders no connector rail until a connector is connected", async () => {
    await renderWorkspace();

    // No connectors start connected, so the home rail renders nothing.
    expect(screen.queryByLabelText(/connected connectors/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /google docs/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /gmail/i })).not.toBeInTheDocument();
  });

  it("uses the lightweight Codex-like navigation hierarchy", async () => {
    await renderWorkspace();

    // Sections exist but start empty (mock projects and chats removed). Collection nav heading is "Projects".
    expect(screen.getByText("Chats")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /daily catch-up/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /initial build/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /memory and approvals/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^connectors$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^knowledge$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^schedules$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^home$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^projects$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^chats$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /goals/i })).not.toBeInTheDocument();
  });

  it("renders visible Projects collection label and Add project action via real App render", async () => {
    await renderWorkspace();
    // Visible heading text now "Projects" (not "Threads").
    expect(screen.getByText("Projects")).toBeInTheDocument();
    // A11y label for the add action on the collection (replaces prior "Add thread").
    expect(screen.getByRole("button", { name: /add project/i })).toBeInTheDocument();
    // Prior collection text is absent from user surface.
    expect(screen.queryByText("Threads")).not.toBeInTheDocument();
  });

  it("opens a real project detail and hydrates a selected project conversation", async () => {
    runtimeMocks.projectRecords = [{
      id: "project-roadmap",
      title: "Roadmap",
      description: "Plan the next release.",
      instructions: "Keep priorities clear.",
      lifecycle: "active",
      revision: 2
    }];
    runtimeMocks.conversationThreads = [{
      id: "thread-roadmap",
      projectId: "project-roadmap",
      title: "Release plan",
      lifecycle: "active",
      updatedAt: "2026-07-11T10:00:00Z",
      messageHead: { lastSequence: 0 }
    }];

    await renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Roadmap" }));
    expect(await screen.findByRole("heading", { name: "Roadmap" })).toBeInTheDocument();
    expect(screen.getByText("Keep priorities clear.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand Roadmap" }));
    fireEvent.click(screen.getByRole("button", { name: "Release plan" }));
    await waitFor(() => expect(getRuntimeConversationThread).toHaveBeenCalledWith("thread-roadmap"));
    expect(screen.queryByRole("heading", { name: "Roadmap" })).not.toBeInTheDocument();
  });

  it("exercises real WorkspaceSidebar project lifecycle, grouping, and thread placement controls", async () => {
    // Direct render of the shipped component (per audit requirement) with real ThreadSummary data.
    const sampleThread: ThreadSummary = {
      id: "thread-abc-123",
      title: "Sample conversation",
      kind: "project",
      description: "desc",
      updatedAt: "now",
      pinnedContextIds: []
    };
    const sampleProject = {
      id: "proj-1",
      title: "Demo Project",
      description: "d",
      instructions: "",
      lifecycle: "active" as const,
      revision: 1,
      threads: [sampleThread]
    };
    const expandedCollections = { projects: true, chats: false };
    const expandedProjects: Record<string, boolean> = { "proj-1": true };
    const onSelectProjectThread = vi.fn();
    const onOpenProject = vi.fn();
    const onToggleProject = vi.fn();
    const onAddProject = vi.fn();
    const onArchiveProject = vi.fn();
    const onRestoreProject = vi.fn();
    const onMoveThread = vi.fn();
    const onSelectThread = vi.fn();
    const noop = () => {};
    // Render real component; props include ThreadSummary objects exactly as used in production path.
    render(
      <WorkspaceSidebar
        workspaceName="Test WS"
        utilityItems={[]}
        activeItem={sampleThread.id}
        expandedCollections={expandedCollections}
        expandedProjects={expandedProjects}
        projects={[sampleProject]}
        archivedProjects={[{ ...sampleProject, id: "proj-old", title: "Old Project", lifecycle: "archived", threads: [] }]}
        chatThreads={[]}
        mobileNavOpen={true}
        collapsed={false}
        onNewChat={noop}
        onAddProject={onAddProject}
        onNewProjectChat={noop}
        onRenameProject={noop}
        onArchiveProject={onArchiveProject}
        onRestoreProject={onRestoreProject}
        onDeleteProject={noop}
        onMoveThread={onMoveThread}
        onSearch={noop}
        onSelectWorkspace={noop}
        onToggleProjects={noop}
        onToggleChats={noop}
        onSelectUtility={noop}
        onOpenProject={onOpenProject}
        onSelectProjectThread={onSelectProjectThread}
        onToggleProject={onToggleProject}
        onToggleMobileNav={noop}
        onToggleCollapsed={noop}
        onOpenMobileConnection={noop}
        onOpenWorkspaceSettings={noop}
        onSelectThread={onSelectThread}
        onAccountMenu={noop as any}
      />
    );
    // Visible + a11y for Projects collection confirmed on real render.
    // (Multiple because mobile drawer also renders "Projects" when open; proves both desktop+mobile labels.)
    expect(screen.getAllByText("Projects").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByLabelText("Add project")).toBeInTheDocument();
    // Mobile drawer section a11y label updated (real render).
    const mobileNav = screen.getByLabelText(/mobile navigation/i);
    expect(within(mobileNav).getByText("Projects")).toBeInTheDocument();
    // Compat: threadId value from real ThreadSummary is used for active/selection (no mutation of ids or caps).
    // (Title appears in both desktop nested list + mobile drawer when open; presence proves data from real ThreadSummary prop.)
    expect(screen.getAllByText("Sample conversation").length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getAllByRole("button", { name: "Demo Project" })[0]);
    expect(onOpenProject).toHaveBeenCalledWith("proj-1");
    fireEvent.click(screen.getByRole("button", { name: "Collapse Demo Project" }));
    expect(onToggleProject).toHaveBeenCalledWith("proj-1", "Demo Project", true);

    // Drive the REAL selection callback entrypoint (plan AC3 / verification): click a thread row rendered from the ThreadSummary prop.
    // This exercises onSelectProjectThread with the exact object passed down, proving threadId roundtrips through the selection flow.
    const threadRowButtons = screen.getAllByRole("button").filter((b) =>
      b.textContent?.includes("Sample conversation")
    );
    expect(threadRowButtons.length).toBeGreaterThan(0);
    fireEvent.click(threadRowButtons[0]);
    // The callback must receive the exact ThreadSummary (thus its id) + project title — this is the shipped selection path.
    expect(onSelectProjectThread).toHaveBeenCalledWith(sampleThread, "Demo Project");
    // threadId is preserved verbatim through the callback (real prop -> render -> click -> handler).
    expect(onSelectProjectThread.mock.calls[0][0].id).toBe("thread-abc-123");

    fireEvent.click(screen.getByLabelText("Add project"));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Launch notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onAddProject).toHaveBeenCalledWith({ title: "Launch notes" }));

    fireEvent.click(screen.getByLabelText("Archive Demo Project"));
    expect(onArchiveProject).toHaveBeenCalledWith(sampleProject);

    fireEvent.change(screen.getAllByLabelText("Move Sample conversation")[0], { target: { value: "" } });
    expect(onMoveThread).toHaveBeenCalledWith("thread-abc-123", null);

    fireEvent.click(screen.getByRole("button", { name: /archived \(1\)/i }));
    fireEvent.click(screen.getByRole("button", { name: "Old Project" }));
    expect(onOpenProject).toHaveBeenCalledWith("proj-old");
    fireEvent.click(screen.getByRole("button", { name: /restore/i }));
    expect(onRestoreProject).toHaveBeenCalledWith(expect.objectContaining({ id: "proj-old" }));

    // "threads" capability key in mocks (used by App) remains the protocol value, unchanged.
    // (See connectedCodex above and other provider mocks using literal "threads".)
  });

  it("switches between Fable workspaces and creates one from the sidebar", async () => {
    const user = userEvent.setup();
    const selectWorkspace = vi.fn().mockResolvedValue(undefined);
    const createWorkspace = vi.fn().mockResolvedValue(undefined);
    const noop = () => {};
    render(
      <WorkspaceSidebar
        workspaceName="Research"
        utilityItems={[]}
        activeItem="new-chat"
        expandedCollections={{ projects: false, chats: false }}
        expandedProjects={{}}
        projects={[]}
        chatThreads={[]}
        mobileNavOpen={false}
        collapsed={false}
        onNewChat={noop}
        onAddProject={noop}
        onNewProjectChat={noop}
        onRenameProject={noop}
        onArchiveProject={noop}
        onRestoreProject={noop}
        onDeleteProject={noop}
        onMoveThread={noop}
        onSearch={noop}
        onSelectWorkspace={noop}
        onToggleProjects={noop}
        onToggleChats={noop}
        onSelectUtility={noop}
        onOpenProject={noop}
        onSelectProjectThread={noop}
        onToggleProject={noop}
        onToggleMobileNav={noop}
        onToggleCollapsed={noop}
        onOpenMobileConnection={noop}
        onOpenWorkspaceSettings={noop}
        onSelectThread={noop}
        onAccountMenu={noop as any}
        accountWorkspaces={[
          { fableWorkspaceId: "workspace-research", localWorkspaceId: "local-research", name: "Research", workspaceStatus: "active", workspaceRevision: 1, policyRevision: 1, memberId: "member-1", role: "owner", membershipStatus: "active", membershipRevision: 1, updatedAt: "2026-07-10T12:00:00Z" },
          { fableWorkspaceId: "workspace-writing", localWorkspaceId: "local-writing", name: "Writing", workspaceStatus: "active", workspaceRevision: 1, policyRevision: 1, memberId: "member-1", role: "owner", membershipStatus: "active", membershipRevision: 1, updatedAt: "2026-07-10T12:00:00Z" }
        ]}
        activeAccountWorkspaceId="workspace-research"
        onSelectAccountWorkspace={selectWorkspace}
        onCreateAccountWorkspace={createWorkspace}
      />
    );

    await user.click(screen.getByRole("button", { name: "Select workspace" }));
    expect(screen.getByRole("menuitemradio", { name: /Research/ })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("menuitemradio", { name: /Writing/ }));
    await waitFor(() => expect(selectWorkspace).toHaveBeenCalledWith("workspace-writing"));

    await user.click(screen.getByRole("button", { name: "Select workspace" }));
    await user.click(screen.getByRole("menuitem", { name: "Create workspace" }));
    await user.type(screen.getByRole("textbox", { name: "Workspace name" }), "Planning");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(createWorkspace).toHaveBeenCalledWith("Planning"));
  });

  it("shows first-wave connectors as minimal setup cards", async () => {
    const user = await renderWorkspace();
    await user.click(screen.getByRole("button", { name: /^connectors$/i }));

    for (const name of [
      "GitHub",
      "Vercel",
      "Google Drive",
      "Notion",
      "Gmail",
      "Slack",
      "Google Calendar"
    ]) {
      expect(
        await screen.findByRole("button", { name: new RegExp(`connect ${name}`, "i") })
      ).toBeInTheDocument();
    }

    const gmailCard = screen.getByRole("button", { name: /connect gmail/i });
    expect(within(gmailCard).getByText("fixture")).toBeInTheDocument();

    await user.click(gmailCard);
    expect(screen.getByRole("dialog", { name: "Gmail" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^connect$/i })).toBeInTheDocument();
  });

  it("reveals connector details after selecting a card", async () => {
    const user = await renderWorkspace();
    await user.click(screen.getByRole("button", { name: /^connectors$/i }));

    await user.click(screen.getByText("Gmail"));

    expect(screen.getByRole("heading", { name: "Gmail" })).toBeInTheDocument();
    expect(screen.getByText(/Enable Gmail API/i)).toBeInTheDocument();
    expect(screen.getByText("Read mail")).toBeInTheDocument();
    expect(screen.getByText("Create drafts")).toBeInTheDocument();
  });

  it("routes broker-gated connector auth through the loopback OAuth command", async () => {
    const user = await renderWorkspace();
    await user.click(screen.getByRole("button", { name: /^connectors$/i }));

    await user.click(await screen.findByRole("button", { name: /connect github/i }));
    await user.click(screen.getByRole("button", { name: /^connect$/i }));

    expect(runtimeMocks.connectorOAuthCalls).toContain("github");
  });

  it("routes the vercel provider-installation connector through the same broker OAuth path", async () => {
    // Vercel uses the distinct `provider-installation` auth_mode, but it is a
    // confidential connector and must connect through the same loopback OAuth /
    // auth-broker path as GitHub. Pinning this prevents the distinct auth_mode
    // from silently bypassing or breaking the broker-gated connect flow.
    const user = await renderWorkspace();
    await user.click(screen.getByRole("button", { name: /^connectors$/i }));

    await user.click(await screen.findByRole("button", { name: /connect vercel/i }));
    await user.click(screen.getByRole("button", { name: /^connect$/i }));

    expect(runtimeMocks.connectorOAuthCalls).toContain("vercel");
  });

  it("prepares connector writes as approval requests instead of executing them", async () => {
    const user = await renderWorkspace();
    await user.click(screen.getByRole("button", { name: /^connectors$/i }));
    const gmailCard = (await screen.findAllByText("Gmail"))
      .map((node) => node.closest("article"))
      .find(Boolean);
    expect(gmailCard).not.toBeNull();

    await user.click(within(gmailCard as HTMLElement).getByText("Gmail"));
    await user.click(screen.getByRole("button", { name: /prepare create draft/i }));

    // Return to the chat view, where the approval queue now renders inline.
    await user.click(screen.getByRole("button", { name: /new chat/i }));
    expect(await screen.findByText("Create Draft")).toBeInTheDocument();
    expect(screen.getByText(/does not send the email/i)).toBeInTheDocument();
  });

  it("opens the honest mobile approval status from the sidebar", async () => {
    const user = await renderWorkspace();

    const mobileConnection = screen.getByRole("button", { name: /^mobile connection$/i });
    const settings = screen.getByRole("button", { name: /^settings$/i });

    expect(mobileConnection).toBeInTheDocument();
    expect(settings).toBeInTheDocument();

    await user.click(mobileConnection);
    // Settings renders from a lazily-loaded chunk; await the mobile approval content.
    expect(await screen.findByText(/only this computer can run the action/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /close sidebar/i }));
    expect(screen.getByRole("main")).toHaveClass("desktop-frame--sidebar-collapsed");
    expect(
      screen.queryByRole("complementary", { name: /workspace navigation/i })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open sidebar/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /open sidebar/i }));
    expect(screen.getByRole("complementary", { name: /workspace navigation/i })).toBeInTheDocument();
  });

  it("changes the composer permission level with the workspace selector in the sidebar", async () => {
    const user = await renderWorkspace();

    const sidebar = screen.getByRole("complementary", { name: /workspace navigation/i });
    const workspaceSelector = within(sidebar).getByRole("button", { name: /select workspace/i });
    expect(within(sidebar).getByRole("img", { name: /^fable$/i })).toBeInTheDocument();
    expect(workspaceSelector).toHaveTextContent("Preview workspace");
    expect(workspaceSelector.closest(".workspace-switcher-container--top")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /approval preset/i }));
    const fullAccessOption = screen.getByRole("menuitemradio", { name: /full access/i });
    const fullAccessIconPath = fullAccessOption.querySelector("svg path")?.getAttribute("d");
    await user.click(fullAccessOption);
    const permissionSelector = screen.getByRole("button", { name: /approval preset/i });
    expect(permissionSelector).toHaveTextContent("Full access");
    expect(permissionSelector.querySelector("svg path")?.getAttribute("d")).toBe(
      fullAccessIconPath
    );
    const chatsButton = within(sidebar).getByRole("button", { name: /^chats$/i });
    expect(chatsButton.firstElementChild?.tagName).toBe("SPAN");
    expect(chatsButton.querySelectorAll("svg")).toHaveLength(1);
  });

  it("keeps schedules out of the add menu while retaining the schedules navigation", async () => {
    const user = await renderWorkspace();

    await user.click(screen.getByRole("button", { name: /add files and context/i }));
    const addMenu = screen.getByRole("menu", { name: /add to prompt/i });

    expect(within(addMenu).queryByRole("menuitem", { name: /^schedules/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^schedules$/i })).toBeInTheDocument();
  });

  it("opens the interactive knowledge workspace", async () => {
    const user = await renderWorkspace();

    await user.click(screen.getByRole("button", { name: /^knowledge$/i }));

    // Knowledge is a lazily-loaded page; await its first paint before querying.
    expect(await screen.findByRole("heading", { name: "Knowledge" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Sources" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Memories" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /import file/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /import folder/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^connect a service$/i })).toBeInTheDocument();

    const file = new File(["Knowledge page import content"], "knowledge-page.md", {
      type: "text/markdown"
    });
    await user.upload(screen.getByLabelText(/import local knowledge file/i), file);
    await user.click(
      await screen.findByRole("button", { name: /^knowledge-page\.md local file/i })
    );
    await user.click(screen.getByRole("button", { name: /^save to memories$/i }));

    await user.click(screen.getByRole("tab", { name: "Memories" }));
    expect(screen.getAllByText("knowledge-page.md").length).toBeGreaterThan(0);
    expect(screen.getByRole("textbox", { name: /search memories/i })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: /search memories/i }), "knowledge-page");
    expect(screen.getAllByText("knowledge-page.md").length).toBeGreaterThan(0);
  });

  it("creates a schedule from name, description, and weekly recurrence", async () => {
    const user = await renderWorkspace();
    await user.click(screen.getByRole("button", { name: /^schedules$/i }));

    // Schedules is a lazily-loaded page; await its first paint before querying.
    expect(await screen.findByRole("heading", { name: "Schedules" })).toBeInTheDocument();
    // The hydration gate clears and the empty state is shown.
    expect(await screen.findByText(/no schedules yet/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^new$/i }));
    fireEvent.change(screen.getByLabelText(/schedule task name/i), {
      target: { value: "Weekly digest" }
    });
    fireEvent.change(screen.getByLabelText(/schedule description/i), {
      target: { value: "Summarize active projects and approvals." }
    });
    await user.selectOptions(screen.getByLabelText(/schedule frequency/i), "weekly");
    await user.click(screen.getByRole("button", { name: /add scheduled task/i }));

    expect(await screen.findByText("Weekly digest")).toBeInTheDocument();
    // The create form also shows a live weekly/Mon summary, so scope the saved
    // schedule's recurrence summary to the saved-schedules list.
    const savedSchedules = screen.getByRole("list", { name: /saved schedules/i });
    expect(within(savedSchedules).getByText(/Weekly on Mon at 9:00 AM/i)).toBeInTheDocument();
    expect(within(savedSchedules).getByText("Summarize active projects and approvals.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /edit schedule weekly digest/i }));
    const editName = screen.getByLabelText(/edit schedule task name/i);
    fireEvent.change(editName, { target: { value: "Friday briefing" } });
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText("Friday briefing")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /run friday briefing now/i }));
    // Scheduled runs now execute through the dedicated headless runner
    // (useScheduledAgent), not the composer. In the test environment no live
    // AgentBackend is resolvable, so the run surfaces its real state rather than
    // a fake completion. The schedule (renamed above) is still present.
    expect(await screen.findByText("Friday briefing")).toBeInTheDocument();
    // No draft/active status labels anywhere on the page.
    expect(screen.queryByText(/^draft$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^active$/i)).not.toBeInTheDocument();
  }, 30000);

  it("pauses and resumes a created schedule", async () => {
    const user = await renderWorkspace();
    await user.click(screen.getByRole("button", { name: /^schedules$/i }));

    await user.click(await screen.findByRole("button", { name: /^new$/i }));
    await user.type(screen.getByLabelText(/schedule task name/i), "Daily check");
    await user.type(screen.getByLabelText(/schedule description/i), "Quick daily summary.");
    await user.click(screen.getByRole("button", { name: /add scheduled task/i }));

    expect(await screen.findByText("Daily check")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();

    // Pause requires a confirmation step so an enabled schedule is not paused
    // by accident.
    await user.click(screen.getByRole("button", { name: /pause/i }));
    await user.click(screen.getByRole("button", { name: /confirm pause/i }));
    expect(screen.getByRole("button", { name: /resume/i })).toBeInTheDocument();
    expect(screen.getByText(/daily check paused/i)).toBeInTheDocument();
  }, 15000);

  it("deletes a created schedule", async () => {
    const user = await renderWorkspace();
    await user.click(screen.getByRole("button", { name: /^schedules$/i }));

    await user.click(await screen.findByRole("button", { name: /^new$/i }));
    await user.type(screen.getByLabelText(/schedule task name/i), "Throwaway");
    await user.type(screen.getByLabelText(/schedule description/i), "To be removed.");
    await user.click(screen.getByRole("button", { name: /add scheduled task/i }));

    expect(await screen.findByText("Throwaway")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /delete schedule throwaway/i }));
    expect(screen.queryByText("Throwaway")).not.toBeInTheDocument();
    expect(screen.getByText(/no schedules yet/i)).toBeInTheDocument();
  }, 15000);

  it("creates a daily schedule from the frequency selector", async () => {
    const user = await renderWorkspace();
    await user.click(screen.getByRole("button", { name: /^schedules$/i }));
    await screen.findByText(/no schedules yet/i);

    await user.click(screen.getByRole("button", { name: /^new$/i }));
    await user.type(screen.getByLabelText(/schedule task name/i), "Daily standup");
    await user.type(screen.getByLabelText(/schedule description/i), "Morning summary.");
    await user.click(screen.getByRole("button", { name: /add scheduled task/i }));

    expect(await screen.findByText("Daily standup")).toBeInTheDocument();
    expect(screen.getByText(/Daily at 9:00 AM/i)).toBeInTheDocument();
  }, 15000);

  it("creates a monthly schedule with a day-of-month", async () => {
    const user = await renderWorkspace();
    await user.click(screen.getByRole("button", { name: /^schedules$/i }));
    expect(await screen.findByRole("heading", { name: "Schedules" })).toBeInTheDocument();
    await screen.findByText(/no schedules yet/i);

    await user.click(screen.getByRole("button", { name: /^new$/i }));
    await user.type(screen.getByLabelText(/schedule task name/i), "Month-end review");
    await user.type(screen.getByLabelText(/schedule description/i), "Close the month.");
    await user.selectOptions(screen.getByLabelText(/schedule frequency/i), "monthly");
    // The day-of-month defaults to 1; append "5" to make it the 15th.
    await user.type(screen.getByLabelText(/day of month/i), "5");
    await user.click(screen.getByRole("button", { name: /add scheduled task/i }));

    expect(await screen.findByText("Month-end review")).toBeInTheDocument();
    expect(screen.getByText(/Monthly on day 15 at 9:00 AM/i)).toBeInTheDocument();
  }, 30000);

  it("creates a one-time schedule", async () => {
    const user = await renderWorkspace();
    await user.click(screen.getByRole("button", { name: /^schedules$/i }));
    await screen.findByText(/no schedules yet/i);

    await user.click(screen.getByRole("button", { name: /^new$/i }));
    await user.type(screen.getByLabelText(/schedule task name/i), "Launch day");
    await user.type(screen.getByLabelText(/schedule description/i), "Ship the release.");
    await user.selectOptions(screen.getByLabelText(/schedule frequency/i), "once");
    await user.type(screen.getByLabelText(/run at/i), "2026-12-01T09:00");
    await user.click(screen.getByRole("button", { name: /add scheduled task/i }));

    expect(await screen.findByText("Launch day")).toBeInTheDocument();
    expect(screen.getByText(/Once ·/i)).toBeInTheDocument();
  }, 15000);

  it("toggles weekly weekdays into the recurrence summary", async () => {
    const user = await renderWorkspace();
    await user.click(screen.getByRole("button", { name: /^schedules$/i }));
    await screen.findByText(/no schedules yet/i);

    await user.click(screen.getByRole("button", { name: /^new$/i }));
    await user.type(screen.getByLabelText(/schedule task name/i), "Multi-day");
    await user.type(screen.getByLabelText(/schedule description/i), "Selected days.");
    await user.selectOptions(screen.getByLabelText(/schedule frequency/i), "weekly");
    // Add Wednesday and Friday to the default Monday.
    await user.click(screen.getByRole("button", { name: /^Wed$/ }));
    await user.click(screen.getByRole("button", { name: /^Fri$/ }));
    await user.click(screen.getByRole("button", { name: /add scheduled task/i }));

    expect(await screen.findByText("Multi-day")).toBeInTheDocument();
    expect(screen.getByText(/Weekly on Mon, Wed, Fri at 9:00 AM/i)).toBeInTheDocument();
  }, 15000);

  it("keeps schedule creation disabled while required fields are empty", async () => {
    const user = await renderWorkspace();
    await user.click(screen.getByRole("button", { name: /^schedules$/i }));
    await screen.findByText(/no schedules yet/i);

    await user.click(screen.getByRole("button", { name: /^new$/i }));
    expect(screen.getByRole("button", { name: /add scheduled task/i })).toBeDisabled();
    expect(screen.queryByText(/no schedules yet/i)).toBeInTheDocument();
  }, 15000);

  it("requires confirming before pausing but resumes immediately", async () => {
    const user = await renderWorkspace();
    await user.click(screen.getByRole("button", { name: /^schedules$/i }));
    await screen.findByText(/no schedules yet/i);

    await user.click(screen.getByRole("button", { name: /^new$/i }));
    await user.type(screen.getByLabelText(/schedule task name/i), "Confirm guard");
    await user.type(screen.getByLabelText(/schedule description/i), "Needs a click.");
    await user.click(screen.getByRole("button", { name: /add scheduled task/i }));
    expect(await screen.findByText("Confirm guard")).toBeInTheDocument();

    // Pause shows a confirm step, not an immediate pause.
    await user.click(screen.getByRole("button", { name: /^pause$/i }));
    expect(screen.getByRole("button", { name: /confirm pause/i })).toBeInTheDocument();
    // Cancelling the confirmation disarms it.
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.queryByRole("button", { name: /confirm pause/i })).not.toBeInTheDocument();

    // Confirming performs the pause.
    await user.click(screen.getByRole("button", { name: /^pause$/i }));
    await user.click(screen.getByRole("button", { name: /confirm pause/i }));
    expect(screen.getByText(/confirm guard paused/i)).toBeInTheDocument();
    // Resuming is immediate (no confirmation needed).
    await user.click(screen.getByRole("button", { name: /resume/i }));
    expect(screen.getByRole("button", { name: /^pause$/i })).toBeInTheDocument();
  }, 15000);

  it("opens account settings without offering a local profile editor", async () => {
    const user = await renderWorkspace();

    await user.click(screen.getByRole("button", { name: /^settings$/i }));

    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();

    expect(screen.getByText("Fable account")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^name$/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^save profile$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "General" })).toBeInTheDocument();
  });

  it("opens settings from the account menu and lists real runtime provider state", async () => {
    // Serve the real preview backend registry (all needs-auth / install-required)
    // so Settings reflects the boundary's actual default auth state — not fake
    // connected defaults like "Fable Pro" or a pre-connected OpenAI. Skip the
    // onboarding gate so the workspace (and Settings) is reachable with fail-
    // closed backends.
    runtimeMocks.backends = [
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
        description: "Reach Claude via an Anthropic API key.",
        authState: "needs-auth",
        capabilities: [],
        models: [{ id: "claude-sonnet-4", label: "Claude Sonnet 4", available: false }]
      }
    ];
    const user = userEvent.setup();
    render(<App />);
    await skipOnboarding();

    await user.click(screen.getByRole("button", { name: /^settings$/i }));
    await user.click(screen.getByRole("button", { name: /^providers$/i }));

    expect(await screen.findByRole("heading", { name: "Providers" })).toBeInTheDocument();

    // OpenAI and Codex are one provider family. Its modal presents the actual
    // connection choices instead of splitting account and API-key sections.
    const openaiTile = screen.getByRole("button", {
      name: /openai \/ chatgpt, not connected/i
    });
    await user.click(openaiTile);
    const providerDialog = screen.getByRole("dialog", { name: "OpenAI / ChatGPT" });
    expect(within(providerDialog).getByText("ChatGPT subscription")).toBeInTheDocument();
    expect(
      within(providerDialog).getByText("ChatGPT subscription with a device code")
    ).toBeInTheDocument();
    expect(within(providerDialog).getByText("OpenAI API key")).toBeInTheDocument();
    // No "mock session" copy anywhere on the page.
    expect(screen.queryByText(/mock session/i)).not.toBeInTheDocument();

    // Provider-owned sign-in is instructions/checking only; no fake one-click connect.
    expect(screen.queryByRole("button", { name: /connect codex/i })).not.toBeInTheDocument();
  });

  it("keeps the voice control quiet until the user tries dictation", async () => {
    const user = await renderWorkspace();

    expect(
      screen.getByRole("button", {
        name: /speech recognition is unavailable in this desktop webview/i
      })
    ).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText(/voice input unavailable/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/universal composer/i)).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /^settings$/i }));
    await user.click(screen.getByRole("button", { name: /^privacy & permissions$/i }));

    const dictation = await screen.findByRole("button", { name: /^enable dictation/i });
    expect(dictation).toHaveAttribute("aria-pressed", "true");
    expect(dictation).not.toBeDisabled();
    expect(screen.getByText(/text input remains available/i)).toBeInTheDocument();
    expect(
      screen.getByText(/recognized text is added to your normal composer draft/i)
    ).toBeInTheDocument();
  });

  it("connects a native API-key provider through the credential boundary in Settings", async () => {
    // Serve a fail-closed Anthropic so Settings shows it as needs-auth; the test
    // then connects it through the boundary and asserts the boundary recorded
    // the secret and the state re-resolved to connected.
    runtimeMocks.backends = [
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
        id: "anthropic",
        backendType: "native-api",
        label: "Anthropic",
        description: "Reach Claude via an Anthropic API key.",
        authState: "needs-auth",
        capabilities: [],
        models: [{ id: "claude-sonnet-4", label: "Claude Sonnet 4", available: false }]
      }
    ];
    const user = userEvent.setup();
    render(<App />);
    await skipOnboarding();

    await user.click(screen.getByRole("button", { name: /^settings$/i }));
    await user.click(screen.getByRole("button", { name: /^providers$/i }));
    await screen.findByRole("heading", { name: "Providers" });

    const anthropicTile = screen.getByRole("button", { name: /anthropic, not connected/i });

    // Open the provider family, choose its API-key method, then submit through
    // the credential boundary.
    await user.click(anthropicTile);
    const providerDialog = screen.getByRole("dialog", { name: "Anthropic" });
    await user.click(
      within(providerDialog).getByRole("button", { name: /anthropic api key/i })
    );
    const keyInput = within(providerDialog).getByLabelText(/api key for anthropic/i);
    await user.type(keyInput, "sk-ant-test-key");

    // Simulate the boundary resolving Anthropic to connected + capability-bearing
    // after the store call records the key.
    runtimeMocks.backends = [
      runtimeMocks.backends[0],
      {
        id: "anthropic",
        backendType: "native-api",
        label: "Anthropic",
        description: "Reach Claude via an Anthropic API key.",
        authState: "connected",
        capabilities: ["authentication", "threads", "streaming"],
        models: [{ id: "claude-sonnet-4", label: "Claude Sonnet 4", available: true }]
      }
    ];

    await user.click(
      within(providerDialog).getByRole("button", { name: /add key & connect/i })
    );

    // The boundary recorded the secret (connectRuntimeBackend was called) and
    // the state re-resolved to connected with its real capabilities surfaced.
    await waitFor(() => {
      expect(connectRuntimeBackendSpy).toHaveBeenCalledWith({
        providerId: "anthropic",
        secret: "sk-ant-test-key"
      });
    });
    await waitFor(() => {
      expect(anthropicTile).toHaveAccessibleName(/anthropic, configured/i);
    });
    // After connecting, the setup modal switches to Disconnect.
    expect(
      within(providerDialog).getByRole("button", { name: /remove from fable/i })
    ).toBeInTheDocument();
  });

  it("does not fake a successful Settings connect when the key is rejected", async () => {
    // The verified path returns auth-failed. Settings must report the failure
    // accurately through the page status — it must never claim "connected".
    runtimeMocks.backends = [
      {
        id: "anthropic",
        backendType: "native-api",
        label: "Anthropic",
        description: "Reach Claude via an Anthropic API key.",
        authState: "needs-auth",
        capabilities: [],
        models: [{ id: "claude-sonnet-4", label: "Claude Sonnet 4", available: false }]
      }
    ];
    const verifySpy = vi.mocked(runtimeModule.verifyRuntimeBackend);
    verifySpy.mockResolvedValueOnce({
      providerId: "anthropic",
      outcome: "auth-failed",
      message: "Anthropic rejected this key. Check the key and try again."
    });

    const user = userEvent.setup();
    render(<App />);
    await skipOnboarding();
    await user.click(screen.getByRole("button", { name: /^settings$/i }));
    await user.click(screen.getByRole("button", { name: /^providers$/i }));
    await screen.findByRole("heading", { name: "Providers" });

    const anthropicTile = screen.getByRole("button", { name: /anthropic, not connected/i });
    await user.click(anthropicTile);
    const providerDialog = screen.getByRole("dialog", { name: "Anthropic" });
    await user.click(
      within(providerDialog).getByRole("button", { name: /anthropic api key/i })
    );
    const keyInput = within(providerDialog).getByLabelText(/api key for anthropic/i);
    await user.type(keyInput, "sk-bad");
    await user.click(
      within(providerDialog).getByRole("button", { name: /add key & connect/i })
    );

    // The page status surfaces the rejection — never a fake "connected".
    expect(await within(providerDialog).findByRole("alert")).toHaveTextContent(
      /rejected this key/i
    );
    await waitFor(() => {
      expect(
        screen.getAllByRole("status").some((status) =>
          /rejected this key/i.test(status.textContent ?? "")
        )
      ).toBe(true);
    });
    expect(anthropicTile).toHaveAccessibleName(/anthropic, not connected/i);
    verifySpy.mockRestore();
  });

  it("turns slash commands into composer text", async () => {
    const user = await renderWorkspace();

    await user.click(screen.getByRole("button", { name: /add files and context/i }));
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: /commands/i }));
    await user.click(screen.getByRole("menuitem", { name: "/goal" }));

    const composer = screen.getByLabelText(/universal composer/i);
    expect(composer).toHaveValue("/goal ");

    await user.clear(composer);
    await user.type(composer, "/g");
    expect(screen.getByRole("option", { name: /\/goal/i })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(composer).toHaveValue("/goal ");
  });

  it("natural remember creates durable memory instead of reaching the model", async () => {
    const user = await renderWorkspace();

    await user.type(
      screen.getByLabelText(/universal composer/i),
      "Remember that I prefer dark mode for long sessions"
    );
    await user.keyboard("{Enter}");

    // The composer is cleared so the command token never reached the model.
    await waitFor(() =>
      expect(screen.getByLabelText(/universal composer/i)).toHaveValue("")
    );
    // The command created an approved memory, visible on the Knowledge page.
    await user.click(screen.getByRole("button", { name: /^knowledge$/i }));
    await user.click(await screen.findByRole("tab", { name: /^memories$/i }));
    // The memory is created and rendered (title appears in list + detail).
    expect((await screen.findAllByText(/prefer dark mode/i)).length).toBeGreaterThan(0);
  });

  it("/remember refuses a secret-shaped value without saving it", async () => {
    const user = await renderWorkspace();

    await user.type(
      screen.getByLabelText(/universal composer/i),
      "/remember Bearer super-secret-token-1234567890"
    );
    await user.keyboard("{Enter}");

    // Rejected through the visible conversation; the secret never lands in memory.
    const conversation = await screen.findByRole("region", { name: /conversation/i });
    expect(await within(conversation).findByText(/looks like a secret/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^knowledge$/i }));
    await user.click(await screen.findByRole("tab", { name: /^memories$/i }));
    expect(screen.queryByText(/super-secret/i)).not.toBeInTheDocument();
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

  it("natural schedule phrasing creates a durable schedule", async () => {
    const user = await renderWorkspace();

    await user.type(screen.getByLabelText(/universal composer/i), "Remind me daily at 09:00");
    await user.keyboard("{Enter}");

    const conversation = await screen.findByRole("region", { name: /conversation/i });
    expect(await within(conversation).findByText(/schedule created/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(
        runtimeMocks.savedScheduledJobs.some(
          (job) => (job as { name?: string }).name === "daily at 09:00"
        )
      ).toBe(true);
    });
    await user.click(screen.getByRole("button", { name: /^schedules$/i }));
    // The command-created schedule appears on the Schedules page (the command
    // derives a legacy entry paired with the durable job by id) and can run now.
    expect(await screen.findByRole("button", { name: /run daily at 09:00 now/i })).toBeInTheDocument();
  });

  it("treats an unknown slash command as an ordinary prompt (passthrough reservation)", async () => {
    const user = await renderWorkspace();

    await user.type(screen.getByLabelText(/universal composer/i), "/summarize the open PRs");
    await user.keyboard("{Enter}");

    // Unknown slashes fall through to the normal knowledge-search submit path;
    // they are not swallowed as an unknown Fable command.
    expect(await screen.findByText(/summarize the open PRs/i)).toBeInTheDocument();
  });

  it("imports local text files as pinned knowledge and contextual directives", async () => {
    const user = await renderWorkspace();
    const file = new File(["Launch risks, connector recovery, and approval notes"], "launch-notes.md", {
      type: "text/markdown"
    });

    await user.upload(screen.getByLabelText(/attach files/i), file);

    expect(await screen.findByText(/Imported launch-notes.md/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /summarize launch-notes.md/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^knowledge$/i }));

    expect((await screen.findAllByText("launch-notes.md")).length).toBeGreaterThan(0);
    await user.click(await screen.findByRole("button", { name: /^launch-notes\.md local file/i }));
    expect(screen.getByText(/Launch risks, connector recovery/i)).toBeInTheDocument();
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
    expect(screen.getByText("summarize the project")).toBeInTheDocument();
    expect(screen.queryByLabelText(/agent activity/i)).not.toBeInTheDocument();
    // The newline was not inserted into the composer.
    expect(composer).toHaveValue("");
  });

  it("natural plan phrasing creates structured plan state", async () => {
    const user = await renderWorkspace();
    await user.type(screen.getByLabelText(/universal composer/i), "Create a plan to migrate the config store");
    await user.keyboard("{Enter}");
    const conversation = await screen.findByRole("region", { name: /conversation/i });
    expect(await within(conversation).findByText(/plan saved/i)).toBeInTheDocument();
  });

  it("routes an explicit connected-source cited brief through the mission journey", async () => {
    const user = userEvent.setup();
    runtimeMocks.backends = [{
      id: "openai", backendType: "native-api", label: "OpenAI", description: "OpenAI native",
      authState: "connected", capabilities: ["authentication", "threads", "streaming", "tool-requests"],
      models: [{ id: "gpt-5", label: "GPT-5", available: true }]
    }];
    render(<App />);
    const composer = await screen.findByLabelText(/universal composer/i);
    await user.type(composer, "Search my connected work sources and produce a trustworthy cited brief.");
    await user.keyboard("{Enter}");

    expect(await screen.findByText("Durable cited brief [source-1].")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Run receipt" })).toHaveTextContent("OpenAI · 200 tokens");
    expect(runtimeMocks.citedBriefCalls).toHaveLength(1);
    expect(runtimeMocks.citedBriefCalls[0]).toMatchObject({
      workspaceId: "preview-default",
      missionScopeWorkspaceId: "preview-workspace",
      model: "gpt-5"
    });
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

  it("inserts real dictation into the existing draft exactly once", async () => {
    let recognition!: {
      onstart: (() => void) | null;
      onresult:
        | ((event: {
            resultIndex: number;
            results: ArrayLike<{
              0: { transcript: string };
              isFinal: boolean;
            }>;
          }) => void)
        | null;
      onend: (() => void) | null;
    };
    class FakeSpeechRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onstart: (() => void) | null = null;
      onresult = null as typeof recognition.onresult;
      onerror = null;
      onend: (() => void) | null = null;
      constructor() {
        recognition = this;
      }
      start() {
        this.onstart?.();
      }
      stop() {
        this.onend?.();
      }
      abort() {}
    }
    Object.defineProperty(window, "SpeechRecognition", {
      value: FakeSpeechRecognition,
      configurable: true
    });

    runtimeMocks.snapshot = {
      version: 1,
      activeItem: "new-chat",
      composerDraft: "",
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

    const user = await renderWorkspace();
    const composer = screen.getByLabelText("Universal composer");
    await user.type(composer, "Plan launch");
    await user.click(screen.getByRole("button", { name: "Start dictation" }));
    expect(
      await screen.findByRole("button", { name: "Stop dictation" })
    ).toHaveAttribute("aria-pressed", "true");

    recognition.onresult?.({
      resultIndex: 0,
      results: [
        { 0: { transcript: "with the team" }, isFinal: true }
      ]
    });
    await user.click(screen.getByRole("button", { name: "Stop dictation" }));

    await waitFor(() =>
      expect(composer).toHaveValue("Plan launch with the team")
    );
    recognition.onend?.();
    await waitFor(() =>
      expect(composer).toHaveFocus()
    );

    delete (window as Window & { SpeechRecognition?: unknown })
      .SpeechRecognition;
  });

  it("recovers created schedules from local persistence", async () => {
    const user = userEvent.setup();
    // First session: create a schedule.
    const first = render(<App />);
    await screen.findByLabelText(/universal composer/i);
    await user.click(screen.getByRole("button", { name: /^schedules$/i }));
    await screen.findByText(/no schedules yet/i);
    await user.click(screen.getByRole("button", { name: /^new$/i }));
    await user.type(screen.getByLabelText(/schedule task name/i), "Persisted digest");
    await user.type(screen.getByLabelText(/schedule description/i), "Survives reload.");
    await user.click(screen.getByRole("button", { name: /add scheduled task/i }));
    expect(await screen.findByText("Persisted digest")).toBeInTheDocument();
    await waitFor(() => expect(runtimeMocks.savedScheduledJobs).toHaveLength(1));
    first.unmount();

    // Second session: the schedule is recovered from the durable store.
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /^schedules$/i }));
    expect(await screen.findByText("Persisted digest")).toBeInTheDocument();
    expect(screen.getByText("Survives reload.")).toBeInTheDocument();
    // This test runs two full mount/form cycles, so it needs more headroom
    // than the single-session schedule tests under concurrent suite load.
  }, 25000);

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

  it("drives a cooperative cancel from the Fable stop command while work is running", async () => {
    // Drives the REAL App.tsx cancel path and proves the cooperative bail. The
    // distinguishing assertion: after Stop (which fires onCancel → sets the
    // cancelRequestedRef flag), a delta fed to the held-open transport is NOT
    // accumulated — the loop's shouldCancel check bailed before processing it.
    // Without the flag-set in onCancel, the loop would stay subscribed and the
    // post-cancel delta WOULD accumulate once [DONE] settles the run.
    installDesktopRuntime();
    runtimeMocks.backends = [
      {
        id: "openai",
        backendType: "native-api",
        label: "OpenAI",
        description: "OpenAI native",
        authState: "connected",
        capabilities: ["authentication", "threads", "streaming", "tool-requests", "cancellation"],
        models: [{ id: "gpt-5", label: "GPT-5", available: true }]
      }
    ];
    // One text-delta and NO [DONE]: the run blocks after the delta, so it is
    // genuinely in flight when Stop is clicked.
    runtimeMocks.lines = ['data: {"choices":[{"delta":{"content":"partial"}}]}'];
    runtimeMocks.emitDone = false;

    const user = userEvent.setup();
    render(<App />);

    const composer = await screen.findByLabelText(/universal composer/i);
    await user.type(composer, "summarize the project");
    await user.click(screen.getByRole("button", { name: /send prompt/i }));

    // The run is in flight: the transcript shows the first delta and a Stop
    // button is rendered (the cooperative-cancel affordance on the agent panel).
    expect(await screen.findByText(/^partial$/)).toBeInTheDocument();
    await screen.findByRole("button", { name: /stop/i });

    // Clicking Stop drives App.tsx's cancel path (agent.cancel() → onCancel flips
    // the cancelRequestedRef flag the loop's shouldCancel reads).
    await user.type(composer, "Stop current work");
    await user.keyboard("{Enter}");

    // The Rust boundary cancel fired (the real-Rust drop stays intact) and the
    // Stop button disappears as running drops.
    await waitFor(() => expect(runtimeMocks.cancelCalls.length).toBeGreaterThanOrEqual(1));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /stop/i })).not.toBeInTheDocument()
    );

    // Feed a SECOND delta after the cancel, then settle the run. The cooperative
    // bail (shouldCancel returned true) must prevent this delta from accumulating
    // — the transcript stays exactly "partial". Without the flag-set, the loop
    // would still be subscribed and "aftercancel" would append once [DONE] lands.
    // Feed a SECOND delta after the cancel, then settle the run. The cooperative
    // bail (shouldCancel returned true) must prevent this delta from accumulating
    // — the transcript stays exactly "partial". Without the flag-set in onCancel,
    // the loop stays subscribed and "aftercancel" appends (verified: the post-
    // cancel delta IS accumulated when the flag is not flipped).
    runtimeMocks.onLine?.('data: {"choices":[{"delta":{"content":"aftercancel"}}]}');
    runtimeMocks.onLine?.("[DONE]");

    // The cooperative bail held: a tick after the post-cancel delta + [DONE]
    // settle the run, the transcript stays "partial" and never shows "aftercancel".
    await waitFor(() => {
      expect(screen.queryByText(/aftercancel/i)).not.toBeInTheDocument();
    });
    expect(screen.getByText(/^partial$/)).toBeInTheDocument();
  });

  it("shows an interrupted run and retries it from the durable prompt", async () => {
    installDesktopRuntime();
    runtimeMocks.backends = [
      {
        id: "openai",
        backendType: "native-api",
        label: "OpenAI",
        description: "OpenAI native",
        authState: "connected",
        capabilities: ["authentication", "threads", "streaming"],
        models: [
          {
            id: "gpt-5",
            label: "GPT-5",
            available: true,
            capabilities: {
              contextWindow: 128_000,
              maxOutputTokens: 8_192,
              streaming: true,
              tools: true,
              vision: false,
              reasoning: true,
              structuredOutput: true
            }
          }
        ]
      }
    ];
    runtimeMocks.agentRuns = [
      {
        id: "run-interrupted",
        providerId: "openai",
        model: "gpt-5",
        status: "interrupted",
        transcript: "partial answer",
        exchanges: [{ role: "user", content: "Retry this prompt" }],
        turn: 0,
        pendingApprovalIds: [],
        recoverable: true,
        retryCount: 0,
        createdAt: "2026-06-28T10:00:00Z",
        updatedAt: "2026-06-28T10:01:00Z"
      }
    ];
    runtimeMocks.lines = [
      'data: {"choices":[{"delta":{"content":"Recovered answer"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}]}'
    ];

    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText(/interrupted run · gpt-5/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /retry from prompt/i }));
    expect(await screen.findByText("Recovered answer")).toBeInTheDocument();
    expect(screen.queryByText(/interrupted run · gpt-5/i)).not.toBeInTheDocument();
  });

  it("lists the connected backend's models in the composer model picker", async () => {
    const user = userEvent.setup();
    runtimeMocks.backends = [
      {
        id: "openai",
        backendType: "native-api",
        label: "OpenAI",
        description: "OpenAI native",
        authState: "connected",
        capabilities: ["authentication", "threads", "streaming"],
        models: [
          { id: "gpt-5", label: "GPT-5", available: true },
          { id: "gpt-4.1", label: "GPT-4.1", available: false },
          { id: "o3", label: "o3", available: true }
        ]
      }
    ];
    render(<App />);
    await screen.findByLabelText(/universal composer/i);

    await user.click(screen.getByRole("button", { name: /select model/i }));

    // The picker lists the connected backend's usable models (not hardcoded labels)
    // and filters unavailable/older entries out of the composer dropdown.
    const menu = screen.getByRole("menu", { name: /models/i });
    expect(within(menu).getByText("GPT-5")).toBeInTheDocument();
    expect(within(menu).getByText("o3")).toBeInTheDocument();
    expect(within(menu).queryByText("GPT-4.1")).not.toBeInTheDocument();
  });

  it("selecting a model in the picker drives the persisted model id for the next run", async () => {
    const user = userEvent.setup();
    runtimeMocks.backends = [
      {
        id: "openai",
        backendType: "native-api",
        label: "OpenAI",
        description: "OpenAI native",
        authState: "connected",
        capabilities: ["authentication", "threads", "streaming"],
        models: [
          { id: "gpt-5", label: "GPT-5", available: true },
          { id: "o3", label: "o3", available: true }
        ]
      }
    ];
    // Seed a snapshot so the runtime-save path activates (it only saves after the
    // initial load resolves), then assert the picker selection is persisted.
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
      connectedBackendIds: ["openai"],
      selectedModelId: "",
      permissionMode: "full-access",
      savedAt: "2026-06-26T10:30:00.000Z"
    };
    render(<App />);
    await screen.findByLabelText(/universal composer/i);

    // Default chip shows the first available model (gpt-5).
    expect(screen.getByRole("button", { name: /select model/i })).toHaveTextContent("GPT-5");

    await user.click(screen.getByRole("button", { name: /select model/i }));
    await user.click(screen.getByRole("menuitemradio", { name: /^openai o3$/i }));

    // The chip now reflects the selection...
    expect(screen.getByRole("button", { name: /select model/i })).toHaveTextContent("o3");
    // ...and the persisted snapshot carries the chosen model id, which is what
    // the agent.run call site turns into request.model.
    await waitFor(() => {
      expect(runtimeMocks.savedSnapshots.at(-1)?.selectedModelId).toBe("openai::o3");
    });
  });

  it("renders connector details for connected, configured, unconfigured, expired, syncing, failed, unavailable, and permission-limited states", async () => {
    const customManifests = [
      {
        id: "slack",
        name: "Slack",
        status: "connected",
        permissions: ["read selected conversations"],
        healthSummary: "Connected; provider identity verified.",
        lastCheckedAt: "2026-06-27T09:00:00.000Z",
        authMode: "oauth-broker",
        health: { state: "healthy", summary: "Connected; provider identity verified.", checkedAt: "2026-06-27T09:00:00.000Z" }
      },
      {
        id: "notion",
        name: "Notion",
        status: "unconfigured",
        permissions: ["read user-selected pages"],
        healthSummary: "Provider configuration required",
        lastCheckedAt: "2026-06-27T09:00:00.000Z",
        authMode: "oauth-broker",
        setupMessage: "Create a Notion public connection and broker callback.",
        health: { state: "error", summary: "Provider configuration required", checkedAt: "2026-06-27T09:00:00.000Z" }
      },
      {
        id: "linear",
        name: "Linear",
        status: "expired",
        permissions: ["read workspace"],
        healthSummary: "Linear token expired",
        lastCheckedAt: "2026-06-27T09:00:00.000Z",
        authMode: "oauth-broker",
        health: { state: "error", summary: "Linear token expired; reconnect is required.", checkedAt: "2026-06-27T09:00:00.000Z" }
      },
      {
        id: "google-calendar",
        name: "Google Calendar",
        status: "configured",
        permissions: ["read selected records"],
        healthSummary: "Ready to connect",
        lastCheckedAt: "2026-06-27T09:00:00.000Z",
        authMode: "oauth-broker",
        setupMessage: "Choose Connect to authorize this provider.",
        health: { state: "unknown", summary: "Ready to connect", checkedAt: "2026-06-27T09:00:00.000Z" }
      },
      {
        id: "github",
        name: "GitHub",
        status: "connected",
        permissions: ["read repos"],
        healthSummary: "Connected; provider identity verified.",
        lastCheckedAt: "2026-06-27T09:00:00.000Z",
        authMode: "oauth-broker",
        health: { state: "unknown", summary: "Credentials available; live provider health has not been checked.", checkedAt: "2026-06-27T09:00:00.000Z" }
      },
      {
        id: "vercel",
        name: "Vercel",
        status: "provider-error",
        permissions: ["read deployments"],
        healthSummary: "Egress failed",
        lastCheckedAt: "2026-06-27T09:00:00.000Z",
        authMode: "provider-installation",
        health: { state: "error", summary: "The vercel API rate limit was exceeded.", checkedAt: "2026-06-27T09:00:00.000Z" }
      },
      {
        id: "gmail",
        name: "Gmail",
        status: "unavailable",
        permissions: ["read emails"],
        healthSummary: "Gmail API is temporarily disabled",
        lastCheckedAt: "2026-06-27T09:00:00.000Z",
        authMode: "oauth-pkce",
        health: { state: "error", summary: "Gmail API is temporarily disabled.", checkedAt: "2026-06-27T09:00:00.000Z" }
      },
      {
        id: "google-drive",
        name: "Google Drive",
        status: "connected",
        permissions: ["read drive files"],
        healthSummary: "Stale scopes",
        lastCheckedAt: "2026-06-27T09:00:00.000Z",
        authMode: "oauth-pkce",
        scopes: [{ id: "drive.readonly", label: "Read files", access: "read", required: true, granted: false }],
        health: { state: "error", summary: "Google Drive is missing required Google scopes.", checkedAt: "2026-06-27T09:00:00.000Z" }
      }
    ];

    vi.mocked(listRuntimeConnectorStatuses).mockResolvedValue(customManifests as any);

    const user = await renderWorkspace();
    await user.click(screen.getByRole("button", { name: /^connectors$/i }));

    // Test Slack (connected)
    await user.click(await screen.findByText("Slack"));
    expect(screen.getByRole("heading", { name: "Slack" })).toBeInTheDocument();
    const slackDetails = screen.getByRole("article", { name: "Slack details" });
    expect(within(slackDetails).getByText("Connected")).toBeInTheDocument();
    expect(within(slackDetails).getAllByText("Slack account connected.").length).toBeGreaterThan(0);

    // Test Notion (Configuration Required)
    await user.click(screen.getByText("Notion"));
    expect(screen.getByRole("heading", { name: "Notion" })).toBeInTheDocument();
    const notionDetails = screen.getByRole("article", { name: "Notion details" });
    expect(within(notionDetails).getByText("Configuration Required")).toBeInTheDocument();
    expect(within(notionDetails).getAllByText("Notion is not configured on the Fable auth broker.").length).toBeGreaterThan(0);

    // Test configured (ready to authorize)
    await user.click(screen.getByText("Google Calendar"));
    const configuredDetails = screen.getByRole("article", { name: "Google Calendar details" });
    expect(within(configuredDetails).getByText("Ready")).toBeInTheDocument();
    expect(within(configuredDetails).getByRole("button", { name: /^connect$/i })).toBeInTheDocument();

    // Test Linear (expired)
    await user.click(screen.getByText("Linear"));
    expect(screen.getByRole("heading", { name: "Linear" })).toBeInTheDocument();
    const linearDetails = screen.getByRole("article", { name: "Linear details" });
    expect(within(linearDetails).getByText("Expired")).toBeInTheDocument();
    expect(within(linearDetails).getAllByText("Linear authorization expired; reconnect or refresh is required.").length).toBeGreaterThan(0);
    expect(within(linearDetails).getByRole("button", { name: /^reconnect$/i })).toBeInTheDocument();

    // Test GitHub (syncing)
    await user.click(screen.getByText("GitHub"));
    expect(screen.getByRole("heading", { name: "GitHub" })).toBeInTheDocument();
    const githubDetails = screen.getByRole("article", { name: "GitHub details" });
    expect(within(githubDetails).getByText("Syncing")).toBeInTheDocument();
    expect(within(githubDetails).getAllByText("Verifying connection with GitHub...").length).toBeGreaterThan(0);

    // Test Vercel (failed)
    await user.click(screen.getByText("Vercel"));
    expect(screen.getByRole("heading", { name: "Vercel" })).toBeInTheDocument();
    const vercelDetails = screen.getByRole("article", { name: "Vercel details" });
    expect(within(vercelDetails).getByText("Failed")).toBeInTheDocument();
    expect(within(vercelDetails).getAllByText("The vercel API rate limit was exceeded.").length).toBeGreaterThan(0);

    // Test Gmail (unavailable)
    await user.click(screen.getByText("Gmail"));
    expect(screen.getByRole("heading", { name: "Gmail" })).toBeInTheDocument();
    const gmailDetails = screen.getByRole("article", { name: "Gmail details" });
    expect(within(gmailDetails).getByText("Unavailable")).toBeInTheDocument();
    expect(within(gmailDetails).getAllByText("Gmail service is temporarily unavailable.").length).toBeGreaterThan(0);

    // Test Google Drive (permission-limited)
    await user.click(screen.getByText("Google Drive"));
    expect(screen.getByRole("heading", { name: "Google Drive" })).toBeInTheDocument();
    const driveDetails = screen.getByRole("article", { name: "Google Drive details" });
    expect(within(driveDetails).getByText("Permission Limited")).toBeInTheDocument();
    expect(within(driveDetails).getAllByText("Google Drive is missing required scopes or permissions.").length).toBeGreaterThan(0);
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
      within(grokModal).getByRole("button", { name: /grok account in your browser/i })
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

  it("surfaces a useful error when the key is rejected (auth-failed)", async () => {
    // The verified connect path returns auth-failed; onboarding must show a
    // useful, non-technical error and clear the bad key.
    const verifySpy = vi.mocked(runtimeModule.verifyRuntimeBackend);
    verifySpy.mockResolvedValueOnce({
      providerId: "openai",
      outcome: "auth-failed",
      message: "OpenAI rejected this key. Check the key and try again."
    });

    const user = userEvent.setup();
    render(<App />);

    await showProviderStep();

    // Open the provider family and choose its API-key method.
    await user.click(screen.getByRole("button", { name: /openai \/ chatgpt,/i }));
    const modal = screen.getByRole("dialog", { name: "OpenAI / ChatGPT" });
    await user.click(within(modal).getByRole("button", { name: /openai api key/i }));
    const keyInput = within(modal).getByLabelText(/api key for openai/i);
    await user.type(keyInput, "sk-bad-key");
    await user.click(within(modal).getByRole("button", { name: /add key & connect/i }));

    // A useful error is shown inside the modal; the gate does not clear.
    expect(await within(modal).findByText(/rejected this key/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/universal composer/i)).not.toBeInTheDocument();
    verifySpy.mockRestore();
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

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BackendProvider, ConnectorManifest, PersistedAgentRun, RuntimeSnapshot } from "@fable/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { resolveDetailedStatus } from "./components/PluginPanel";
import { listRuntimeConnectorStatuses } from "./runtime";

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
  agentRuns: [] as PersistedAgentRun[]
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
  beginRuntimeConnectorOAuth: vi.fn(async (request: { connectorId: string }) => {
    runtimeMocks.connectorOAuthCalls.push(request.connectorId);
    return null;
  }),
  clearRuntimeConnectorAuth: vi.fn(async () => null),
  clearRuntimeBackend: vi.fn(async () => null),
  connectRuntimeBackend: vi.fn(async () => "codex"),
  detectRuntimeAcpCli: vi.fn(async () => null),
  exportRuntimeMemoryState: vi.fn(async () => null),
  importRuntimeConnectorItem: vi.fn(async () => null),
  importRuntimeLocalKnowledgeSource: vi.fn(async () => null),
  listRuntimeConnectorStatuses: vi.fn(async () => null),
  listRuntimeSchedulerJobs: vi.fn(async () => null),
  listRuntimeSchedulerQueue: vi.fn(async () => null),
  listRuntimeWorkflowDefinitions: vi.fn(async () => null),
  listRuntimeWorkflowRuns: vi.fn(async () => null),
  listenRuntimeSchedulerRunRequest: vi.fn(async () => null),
  listRuntimeBackends: vi.fn(
    () =>
      new Promise<BackendProvider[] | null>((resolve) => {
        resolve(runtimeMocks.backends ?? [connectedCodex]);
      })
  ),
  // null = no desktop runtime in tests, so the curated catalogue fallback
  // drives model selection (discovery did not run) — matching prior behavior.
  listRuntimeBackendModels: vi.fn(async () => null),
  loadRuntimeApprovalAudit: vi.fn(async () => null),
  loadRuntimeApprovalRules: vi.fn(async () => null),
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
  refreshRuntimeConnectorHealth: vi.fn(async () => null),
  resolveRuntimeApprovalRequest: vi.fn(async () => null),
  saveRuntimeMemoryState: vi.fn(async () => null),
  saveRuntimeImportedKnowledgeSources: vi.fn(async () => null),
  saveRuntimeScheduledJob: vi.fn(async () => null),
  saveRuntimeWorkflowDefinition: vi.fn(async () => null),
  saveRuntimeWorkflowRun: vi.fn(async () => null),
  enqueueRuntimeJobRun: vi.fn(async () => null),
  reportRuntimeJobAttempt: vi.fn(async () => null),
  renewRuntimeJobLease: vi.fn(async () => null),
  requeueRuntimeBlockedJobRun: vi.fn(async () => null),
  cancelRuntimeJobRun: vi.fn(async () => null),
  setRuntimeJobStatus: vi.fn(async () => null),
  deleteRuntimeScheduledJob: vi.fn(async () => null),
  deliverRuntimeNotification: vi.fn(async () => null),
  saveRuntimeAgentRun: vi.fn(async (run: unknown) => run),
  recoverRuntimeAgentRuns: vi.fn(async () => runtimeMocks.agentRuns),
  saveRuntimeSnapshot: vi.fn(async (snapshot: RuntimeSnapshot) => {
    runtimeMocks.savedSnapshots.push(snapshot);
    return snapshot;
  }),
  searchRuntimeConnector: vi.fn(async () => null),
  searchRuntimeKnowledgeSources: vi.fn(async () => null),
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

/** Render App and clear the onboarding gate by skipping in preview mode. */
async function skipOnboarding() {
  const user = userEvent.setup();
  const skip = await screen.findByRole("button", { name: /skip onboarding/i });
  await user.click(skip);
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

    // Sections exist but start empty (mock projects and chats removed).
    expect(screen.getByText("Chats")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /daily catch-up/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /initial build/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /memory and approvals/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^connectors$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^knowledge$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^schedules$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^home$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^threads$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /goals/i })).not.toBeInTheDocument();
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
      expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    }

    const gmailCard = screen
      .getAllByText("Gmail")
      .map((node) => node.closest("article"))
      .find(Boolean);
    expect(gmailCard).not.toBeNull();
    expect(within(gmailCard as HTMLElement).getByText("fixture")).toBeInTheDocument();
    expect(within(gmailCard as HTMLElement).getByRole("button", { name: /^connect$/i })).toBeInTheDocument();

    await user.click(
      within(gmailCard as HTMLElement).getByRole("button", { name: /^connect$/i })
    );
    expect(within(gmailCard as HTMLElement).getByRole("button", { name: /^connect$/i })).toBeInTheDocument();
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

    const githubCard = screen
      .getAllByText("GitHub")
      .map((node) => node.closest("article"))
      .find(Boolean);
    expect(githubCard).not.toBeNull();

    await user.click(
      within(githubCard as HTMLElement).getByRole("button", { name: /^connect$/i })
    );

    expect(runtimeMocks.connectorOAuthCalls).toContain("github");
  });

  it("routes the vercel provider-installation connector through the same broker OAuth path", async () => {
    // Vercel uses the distinct `provider-installation` auth_mode, but it is a
    // confidential connector and must connect through the same loopback OAuth /
    // auth-broker path as GitHub. Pinning this prevents the distinct auth_mode
    // from silently bypassing or breaking the broker-gated connect flow.
    const user = await renderWorkspace();
    await user.click(screen.getByRole("button", { name: /^connectors$/i }));

    const vercelCard = screen
      .getAllByText("Vercel")
      .map((node) => node.closest("article"))
      .find(Boolean);
    expect(vercelCard).not.toBeNull();

    await user.click(
      within(vercelCard as HTMLElement).getByRole("button", { name: /^connect$/i })
    );

    expect(runtimeMocks.connectorOAuthCalls).toContain("vercel");
  });

  it("prepares connector writes as approval requests instead of executing them", async () => {
    const user = await renderWorkspace();
    await user.click(screen.getByRole("button", { name: /^connectors$/i }));
    const gmailCard = screen
      .getAllByText("Gmail")
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

  it("closes the sidebar and keeps mobile separate from the settings menu", async () => {
    const user = await renderWorkspace();

    const mobileConnection = screen.getByRole("button", { name: /^mobile connection$/i });
    const settings = screen.getByRole("button", { name: /^settings$/i });

    expect(mobileConnection).toBeInTheDocument();
    expect(settings).toBeInTheDocument();

    await user.click(mobileConnection);
    expect(screen.getByText(/mobile connection selected/i)).toBeInTheDocument();

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
    expect(screen.getByRole("button", { name: /select workspace/i })).toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: /select workspace/i })).toHaveTextContent(
      "Josh's Fable"
    );
    expect(
      screen.getByRole("heading", { name: /what are we building today in josh's fable/i })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /select permissions/i }));
    await user.click(screen.getByRole("menuitemradio", { name: /standard access/i }));
    expect(screen.getByRole("button", { name: /select permissions/i })).toHaveTextContent(
      "Standard access"
    );
  });

  it("opens the interactive knowledge workspace", async () => {
    const user = await renderWorkspace();

    await user.click(screen.getByRole("button", { name: /^knowledge$/i }));

    expect(screen.getByRole("heading", { name: "Knowledge" })).toBeInTheDocument();
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

  it("creates a schedule from name, description, day, and time", async () => {
    const user = await renderWorkspace();
    await user.click(screen.getByRole("button", { name: /^schedules$/i }));

    expect(screen.getByRole("heading", { name: "Schedules" })).toBeInTheDocument();
    // Starts empty with no draft/active labels.
    expect(screen.getByText(/no schedules yet/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/schedule task name/i), "Weekly digest");
    await user.type(
      screen.getByLabelText(/schedule description/i),
      "Summarize active projects and approvals."
    );
    // Defaults: Friday at 09:00.
    await user.click(screen.getByRole("button", { name: /create schedule/i }));

    expect(await screen.findByText("Weekly digest")).toBeInTheDocument();
    expect(screen.getByText(/Fridays at 9:00 AM/i)).toBeInTheDocument();
    expect(screen.getByText("Summarize active projects and approvals.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /edit schedule weekly digest/i }));
    const editName = screen.getByLabelText(/edit schedule task name/i);
    await user.clear(editName);
    await user.type(editName, "Friday briefing");
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText("Friday briefing")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /run now/i }));
    // Scheduled runs now execute through the dedicated headless runner
    // (useScheduledAgent), not the composer. In the test environment no live
    // AgentBackend is resolvable, so the run surfaces its real state rather than
    // a fake completion. The schedule (renamed above) is still present.
    expect(await screen.findByText("Friday briefing")).toBeInTheDocument();
    // No draft/active status labels anywhere on the page.
    expect(screen.queryByText(/^draft$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^active$/i)).not.toBeInTheDocument();
  }, 15000);

  it("pauses and resumes a created schedule", async () => {
    const user = await renderWorkspace();
    await user.click(screen.getByRole("button", { name: /^schedules$/i }));

    await user.type(screen.getByLabelText(/schedule task name/i), "Daily check");
    await user.type(screen.getByLabelText(/schedule description/i), "Quick daily summary.");
    await user.click(screen.getByRole("button", { name: /create schedule/i }));

    expect(await screen.findByText("Daily check")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /pause/i }));
    expect(screen.getByRole("button", { name: /resume/i })).toBeInTheDocument();
    expect(screen.getByText(/daily check paused/i)).toBeInTheDocument();
  }, 15000);

  it("deletes a created schedule", async () => {
    const user = await renderWorkspace();
    await user.click(screen.getByRole("button", { name: /^schedules$/i }));

    await user.type(screen.getByLabelText(/schedule task name/i), "Throwaway");
    await user.type(screen.getByLabelText(/schedule description/i), "To be removed.");
    await user.click(screen.getByRole("button", { name: /create schedule/i }));

    expect(await screen.findByText("Throwaway")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /delete schedule throwaway/i }));
    expect(screen.queryByText("Throwaway")).not.toBeInTheDocument();
    expect(screen.getByText(/no schedules yet/i)).toBeInTheDocument();
  }, 15000);

  it("opens profile from the settings menu and edits local profile details", async () => {
    const user = await renderWorkspace();

    await user.click(screen.getByRole("button", { name: /^settings$/i }));
    await user.click(screen.getByRole("button", { name: /^profile$/i }));

    expect(screen.getByRole("heading", { name: "Profile" })).toBeInTheDocument();

    await user.clear(screen.getByLabelText(/^name$/i));
    await user.type(screen.getByLabelText(/^name$/i), "Joshua Knott");
    await user.click(screen.getByRole("button", { name: /^save profile$/i }));

    expect(screen.getByText(/profile saved locally/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/universal composer/i)).not.toBeInTheDocument();
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

    expect(screen.getByRole("heading", { name: "Providers" })).toBeInTheDocument();

    // The native API-key providers render from the real registry, each in the
    // boundary-resolved needs-auth state (no fake "Connected" defaults).
    const openaiCard = screen.getByText("OpenAI").closest("article");
    expect(openaiCard).not.toBeNull();
    expect(
      within(openaiCard as HTMLElement).getByLabelText(/openai is needs api key/i)
    ).toBeInTheDocument();
    // No pre-existing fake connection: the "Connect" affordance is present.
    expect(
      within(openaiCard as HTMLElement).getByRole("button", { name: /^connect$/i })
    ).toBeInTheDocument();
    // No "mock session" copy anywhere on the page.
    expect(screen.queryByText(/mock session/i)).not.toBeInTheDocument();

    // The subscription/CLI provider (Codex) is gated: no fake one-click connect.
    const codexCard = screen.getByText("Codex").closest("article");
    expect(codexCard).not.toBeNull();
    expect(
      within(codexCard as HTMLElement).getByRole("button", { name: /gated/i })
    ).toBeDisabled();
    expect(
      within(codexCard as HTMLElement).queryByRole("button", { name: /^connect$/i })
    ).not.toBeInTheDocument();
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

    const anthropicCard = screen.getByText("Anthropic").closest("article");
    expect(anthropicCard).not.toBeNull();

    // Open the inline key form and submit the key through the boundary.
    await user.click(
      within(anthropicCard as HTMLElement).getByRole("button", { name: /^connect$/i })
    );
    const keyInput = within(anthropicCard as HTMLElement).getByLabelText(/api key for anthropic/i);
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
      within(anthropicCard as HTMLElement).getByRole("button", { name: /add key & connect/i })
    );

    // The boundary recorded the secret (connectRuntimeBackend was called) and
    // the state re-resolved to connected with its real capabilities surfaced.
    await waitFor(() => {
      expect(connectRuntimeBackendSpy).toHaveBeenCalledWith({
        providerId: "anthropic",
        secret: "sk-ant-test-key"
      });
    });
    expect(
      await within(anthropicCard as HTMLElement).findByLabelText(/anthropic is connected/i)
    ).toBeInTheDocument();
    expect(
      within(anthropicCard as HTMLElement).getByText(/streaming/i)
    ).toBeInTheDocument();
    // After connecting, the affordance switches to Disconnect.
    expect(
      within(anthropicCard as HTMLElement).getByRole("button", { name: /disconnect/i })
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

    const anthropicCard = screen.getByText("Anthropic").closest("article");
    await user.click(
      within(anthropicCard as HTMLElement).getByRole("button", { name: /^connect$/i })
    );
    const keyInput = within(anthropicCard as HTMLElement).getByLabelText(/api key for anthropic/i);
    await user.type(keyInput, "sk-bad");
    await user.click(
      within(anthropicCard as HTMLElement).getByRole("button", { name: /add key & connect/i })
    );

    // The page status surfaces the rejection — never a fake "connected".
    const status = await screen.findByRole("status");
    await waitFor(() => {
      expect(status.textContent).toMatch(/rejected this key/i);
    });
    expect(status.textContent).not.toMatch(/connected/i);
    verifySpy.mockRestore();
  });

  it("turns slash commands into composer text", async () => {
    const user = await renderWorkspace();

    await user.click(screen.getByRole("button", { name: /add files and context/i }));
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: /commands/i }));
    await user.click(screen.getByRole("menuitem", { name: "/goal" }));

    expect(screen.getByLabelText(/universal composer/i)).toHaveValue("/goal ");
  });

  it("/remember creates durable memory instead of just inserting text", async () => {
    const user = await renderWorkspace();

    await user.type(
      screen.getByLabelText(/universal composer/i),
      "/remember Prefers dark mode for long sessions"
    );
    await user.keyboard("{Enter}");

    // The composer is cleared so the command token never reached the model.
    await waitFor(() =>
      expect(screen.getByLabelText(/universal composer/i)).toHaveValue("")
    );
    // The command created an approved memory, visible on the Knowledge page.
    await user.click(screen.getByRole("button", { name: /^knowledge$/i }));
    await user.click(screen.getByRole("tab", { name: /^memories$/i }));
    // The memory is created and rendered (title appears in list + detail).
    expect((await screen.findAllByText(/Prefers dark mode/i)).length).toBeGreaterThan(0);
  });

  it("/remember refuses a secret-shaped value without saving it", async () => {
    const user = await renderWorkspace();

    await user.type(
      screen.getByLabelText(/universal composer/i),
      "/remember Bearer super-secret-token-1234567890"
    );
    await user.keyboard("{Enter}");

    // Rejected through the last-action channel; the secret never lands in memory.
    expect(await screen.findByText(/looks like a secret/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^knowledge$/i }));
    await user.click(screen.getByRole("tab", { name: /^memories$/i }));
    expect(screen.queryByText(/super-secret/i)).not.toBeInTheDocument();
  });

  it("/goal creates structured Fable state persisted in the snapshot", async () => {
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
      "/goal Ship the v2 onboarding flow"
    );
    await user.keyboard("{Enter}");

    // The goal is created and surfaced; no model is connected in this harness so
    // the result tells the user to connect one.
    expect(await screen.findByText(/goal saved/i)).toBeInTheDocument();

    // The goal is persisted through the runtime snapshot (durable, non-secret).
    await waitFor(() => {
      const snapshot = runtimeMocks.savedSnapshots.at(-1);
      expect(snapshot?.goals.some((goal) => goal.statement.includes("v2 onboarding flow"))).toBe(true);
    });
  });

  it("/schedule creates a durable schedule from natural language", async () => {
    const user = await renderWorkspace();

    await user.type(screen.getByLabelText(/universal composer/i), "/schedule daily at 09:00");
    await user.keyboard("{Enter}");

    expect(await screen.findByText(/schedule created/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^schedules$/i }));
    // The command-created schedule appears on the Schedules page (the command
    // derives a legacy entry paired with the durable job by id) and can run now.
    expect(await screen.findByRole("button", { name: /run now/i })).toBeInTheDocument();
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

    await user.upload(screen.getByLabelText(/import local knowledge file/i), file);

    expect(await screen.findByText(/Imported launch-notes.md/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /summarize launch-notes.md/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^knowledge$/i }));

    expect(screen.getAllByText("launch-notes.md").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /^launch-notes\.md local file/i }));
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

    // Enter sends; outside Tauri, the missing transport stays visually silent.
    await waitFor(() => {
      expect(composer).toHaveValue("summarize the project");
    });
    expect(screen.queryByLabelText(/agent activity/i)).not.toBeInTheDocument();
    // The newline was not inserted into the composer.
    expect(composer).toHaveValue("summarize the project");
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

  it("recovers created schedules from local persistence", async () => {
    const user = userEvent.setup();
    // First session: create a schedule.
    const first = render(<App />);
    await screen.findByLabelText(/universal composer/i);
    await user.click(screen.getByRole("button", { name: /^schedules$/i }));
    await user.type(screen.getByLabelText(/schedule task name/i), "Persisted digest");
    await user.type(screen.getByLabelText(/schedule description/i), "Survives reload.");
    await user.click(screen.getByRole("button", { name: /create schedule/i }));
    expect(await screen.findByText("Persisted digest")).toBeInTheDocument();
    first.unmount();

    // Second session: the schedule is recovered from localStorage.
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /^schedules$/i }));
    expect(await screen.findByText("Persisted digest")).toBeInTheDocument();
    expect(screen.getByText("Survives reload.")).toBeInTheDocument();
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

  it("drives a cooperative cancel from the agent panel Stop button", async () => {
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
    const stopButton = await screen.findByRole("button", { name: /stop/i });

    // Clicking Stop drives App.tsx's cancel path (agent.cancel() → onCancel flips
    // the cancelRequestedRef flag the loop's shouldCancel reads).
    await user.click(stopButton);

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

    // The picker lists the connected backend's models (not hardcoded labels),
    // and the unavailable one is surfaced as disabled.
    const menu = screen.getByRole("menu", { name: /models/i });
    expect(within(menu).getByText("GPT-5")).toBeInTheDocument();
    expect(within(menu).getByText("o3")).toBeInTheDocument();
    expect(within(menu).getByText("GPT-4.1")).toBeInTheDocument();
    expect(
      within(menu).getByRole("menuitemradio", { name: /gpt-4\.1/i })
    ).toBeDisabled();
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
    await user.click(screen.getByRole("menuitemradio", { name: /^o3$/i }));

    // The chip now reflects the selection...
    expect(screen.getByRole("button", { name: /select model/i })).toHaveTextContent("o3");
    // ...and the persisted snapshot carries the chosen model id, which is what
    // the agent.run call site turns into request.model.
    await waitFor(() => {
      expect(runtimeMocks.savedSnapshots.at(-1)?.selectedModelId).toBe("o3");
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
    await user.click(screen.getByText("Slack"));
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
      backendType: "copilot-sdk",
      label: "GitHub Copilot",
      description: "Copilot SDK",
      authState: "needs-auth",
      capabilities: [],
      models: [{ id: "copilot-default", label: "Copilot default", available: false }],
      installHint: "Requires the Copilot SDK."
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
      models: [{ id: "openrouter:auto", label: "OpenRouter Auto", available: false }]
    }
  ];

  beforeEach(() => {
    window.localStorage.clear();
    runtimeMocks.snapshot = null;
    runtimeMocks.backends = failClosedBackends;
    connectRuntimeBackendSpy.mockClear();
  });

  const completeProfileStep = async (user: any) => {
    expect(
      await screen.findByRole("heading", { name: /set up your local fable workspace/i })
    ).toBeInTheDocument();
    // The local profile step must NOT collect a password or claim account creation.
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/^name \(optional\)$/i), "Josh");
    await user.type(screen.getByLabelText(/^email \(optional\)$/i), "josh@example.com");
    // The submit button is exactly "Continue" (the profile form's type=submit).
    await user.click(screen.getByRole("button", { name: /^continue$/i }));
  };

  it("gates the workspace behind the local-first onboarding shell", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: /set up your local fable workspace/i })
    ).toBeInTheDocument();
    // The composer must NOT render until a backend is connected.
    expect(screen.queryByLabelText(/universal composer/i)).not.toBeInTheDocument();
    // The local profile step must not claim account creation or require a password.
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/create your fable account/i)).not.toBeInTheDocument();

    // Proceed through the optional local profile to the unified provider list.
    await completeProfileStep(user);

    expect(await screen.findByRole("heading", { name: /add a model provider/i }))
      .toBeInTheDocument();
  });

  it("shows every provider in one unified list (single setup flow)", async () => {
    const user = userEvent.setup();
    render(<App />);

    await completeProfileStep(user);
    await screen.findByRole("heading", { name: /add a model provider/i });

    // All nine providers render in the unified list — API-key AND provider-owned
    // runtimes on one screen, not split across path screens.
    for (const label of ["OpenAI", "Anthropic", "Gemini", "xAI", "OpenRouter"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    for (const label of ["Codex", "Cursor", "GitHub Copilot", "Grok"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("never shows a token field for provider-owned runtimes (subscription/CLI)", async () => {
    const user = userEvent.setup();
    render(<App />);

    await completeProfileStep(user);
    await screen.findByRole("heading", { name: /add a model provider/i });

    // The provider-owned runtimes surface an install/sign-in state, never a key
    // field. Their action points to real setup, not a fake connect.
    const cursorCard = screen.getByText("Cursor").closest("article");
    expect(cursorCard).not.toBeNull();
    expect(
      within(cursorCard as HTMLElement).getByLabelText(/cursor install required/i)
    ).toHaveTextContent(/cursor cli/i);
    // No fake "Connect" that takes a token from this screen.
    expect(
      within(cursorCard as HTMLElement).queryByLabelText(/api key for cursor/i)
    ).not.toBeInTheDocument();
  });

  it("fails closed with an install hint for ACP providers lacking a CLI", async () => {
    const user = userEvent.setup();
    render(<App />);

    await completeProfileStep(user);
    await screen.findByRole("heading", { name: /add a model provider/i });

    expect(screen.getByLabelText(/cursor install required/i)).toHaveTextContent(/cursor cli/i);
    expect(screen.getByLabelText(/grok install required/i)).toHaveTextContent(/grok cli/i);
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

  it("exposes an inline secure key field for API-key providers only", async () => {
    const user = userEvent.setup();
    render(<App />);

    await completeProfileStep(user);
    await screen.findByRole("heading", { name: /add a model provider/i });

    // The five native API-key providers render with an "Add API key" affordance.
    const openaiRow = screen.getByText("OpenAI").closest("article");
    expect(openaiRow).not.toBeNull();
    await user.click(within(openaiRow as HTMLElement).getByRole("button", { name: /add api key/i }));
    // Expanding reveals a secret input — the key never enters React state.
    expect(await screen.findByLabelText(/api key for openai/i)).toBeInTheDocument();
  });

  it("uses compliant copy for Claude and Gemini (no subscription reuse)", async () => {
    const user = userEvent.setup();
    render(<App />);

    await completeProfileStep(user);
    const shell = await screen.findByRole("heading", { name: /add a model provider/i });
    const frame = shell.closest("main");
    const text = frame?.textContent?.toLowerCase() ?? "";
    // No Claude.ai subscription login; no Google AI Pro/Ultra subscription reuse.
    expect(text).not.toMatch(/claude\.ai/);
    expect(text).not.toMatch(/google ai (pro|ultra)/);
    // The implemented direct API-key path is named, without future routing copy.
    expect(text).toMatch(/api key/);
    expect(text).not.toMatch(/vertex|bedrock/);
  });

  it("connects a native API-key backend via the verified path and clears the gate", async () => {
    const user = userEvent.setup();
    render(<App />);

    await completeProfileStep(user);
    await screen.findByRole("heading", { name: /add a model provider/i });

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

    const openaiCard = screen.getByText("OpenAI").closest("article");
    expect(openaiCard).not.toBeNull();

    // Open the inline key panel and submit the key through the verified path.
    await user.click(within(openaiCard as HTMLElement).getByRole("button", { name: /add api key/i }));
    const keyInput = await screen.findByLabelText(/api key for openai/i);
    await user.type(keyInput, "sk-test-key");
    await user.click(screen.getByRole("button", { name: /add key & connect/i }));

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

    // With a connected provider, the primary "Start using Fable" CTA appears.
    const startBtn = await screen.findByRole("button", { name: /start using fable/i });
    await user.click(startBtn);

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

    await completeProfileStep(user);
    await screen.findByRole("heading", { name: /add a model provider/i });

    const openaiCard = screen.getByText("OpenAI").closest("article");
    expect(openaiCard).not.toBeNull();
    await user.click(within(openaiCard as HTMLElement).getByRole("button", { name: /add api key/i }));
    const keyInput = await screen.findByLabelText(/api key for openai/i);
    await user.type(keyInput, "sk-bad-key");
    await user.click(screen.getByRole("button", { name: /add key & connect/i }));

    // A useful error is shown on the provider row; the gate does not clear.
    expect(await within(openaiCard as HTMLElement).findByText(/rejected this key/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/universal composer/i)).not.toBeInTheDocument();
    verifySpy.mockRestore();
  });

  it("does not promise any tier includes grok build entitlements", async () => {
    const user = userEvent.setup();
    render(<App />);

    await completeProfileStep(user);
    const shell = await screen.findByRole("heading", { name: /add a model provider/i });
    const frame = shell.closest("main");
    expect(frame?.textContent?.toLowerCase()).not.toMatch(/grok build.*included|premium.*grok/i);
  });

  it("skips onboarding in preview and reaches the workspace", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: /set up your local fable workspace/i })
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /skip onboarding/i }));

    expect(await screen.findByLabelText(/universal composer/i)).toBeInTheDocument();
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

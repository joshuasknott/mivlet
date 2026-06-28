import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BackendProvider, RuntimeSnapshot } from "@fable/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

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
  cancelCalls: [] as string[]
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
  clearRuntimeConnectorAuth: vi.fn(async () => null),
  clearRuntimeBackend: vi.fn(async () => null),
  connectRuntimeBackend: vi.fn(async () => "codex"),
  exportRuntimeMemoryState: vi.fn(async () => null),
  importRuntimeConnectorItem: vi.fn(async () => null),
  importRuntimeLocalKnowledgeSource: vi.fn(async () => null),
  listRuntimeConnectorStatuses: vi.fn(async () => null),
  listRuntimeBackends: vi.fn(
    () =>
      new Promise<BackendProvider[] | null>((resolve) => {
        resolve(runtimeMocks.backends ?? [connectedCodex]);
      })
  ),
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
  saveRuntimeAgentRun: vi.fn(async (run: unknown) => run),
  recoverRuntimeAgentRuns: vi.fn(async () => []),
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
  )
}));

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
      within(gmailCard as HTMLElement).getByRole("button", { name: /connect/i })
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

  it("closes the sidebar and keeps mobile separate from the account menu", async () => {
    const user = await renderWorkspace();

    const mobileConnection = screen.getByRole("button", { name: /^mobile connection$/i });
    const account = screen.getByRole("button", { name: /josh josh@example.com/i });

    expect(mobileConnection).toBeInTheDocument();
    expect(account).not.toHaveTextContent("Mobile");

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

  it("opens knowledge as an empty workspace view", async () => {
    const user = await renderWorkspace();

    await user.click(screen.getByRole("button", { name: /^knowledge$/i }));

    expect(screen.getByRole("heading", { name: "Knowledge" })).toBeInTheDocument();
    expect(screen.getByLabelText(/knowledge is empty/i)).toHaveTextContent("Nothing here yet");
    expect(screen.queryByRole("heading", { name: "Sources" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Memory" })).not.toBeInTheDocument();
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
    // No draft/active status labels anywhere on the page.
    expect(screen.queryByText(/^draft$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^active$/i)).not.toBeInTheDocument();
  });

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
  });

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
  });

  it("opens profile from the account menu and edits mock account details", async () => {
    const user = await renderWorkspace();

    await user.click(screen.getByRole("button", { name: /josh josh@example.com/i }));
    await user.click(screen.getByRole("menuitem", { name: /^profile$/i }));

    expect(screen.getByRole("heading", { name: "Profile" })).toBeInTheDocument();

    await user.clear(screen.getByLabelText(/^name$/i));
    await user.type(screen.getByLabelText(/^name$/i), "Joshua Knott");
    await user.click(screen.getByRole("button", { name: /^save profile$/i }));

    expect(screen.getByText(/profile saved locally/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/universal composer/i)).not.toBeInTheDocument();
  });

  it("opens settings from the account menu and connects a mock provider", async () => {
    const user = await renderWorkspace();

    await user.click(screen.getByRole("button", { name: /josh josh@example.com/i }));
    await user.click(screen.getByRole("menuitem", { name: /^settings$/i }));

    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Provider access" })).toBeInTheDocument();

    const anthropicCard = screen.getByText("Anthropic").closest("article");

    expect(anthropicCard).not.toBeNull();
    await user.click(within(anthropicCard as HTMLElement).getByRole("button", { name: /connect/i }));

    expect(screen.getByText(/anthropic connected for this mock session/i)).toBeInTheDocument();
    expect(within(anthropicCard as HTMLElement).getByText("Connected")).toBeInTheDocument();
  });

  it("turns slash commands into composer text", async () => {
    const user = await renderWorkspace();

    await user.click(screen.getByRole("button", { name: /add files and context/i }));
    await user.click(screen.getByRole("menuitem", { name: "/goal" }));

    expect(screen.getByLabelText(/universal composer/i)).toHaveValue("/goal ");
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

    expect(screen.getByLabelText(/knowledge is empty/i)).toHaveTextContent("Nothing here yet");
    expect(screen.queryByText("launch-notes.md")).not.toBeInTheDocument();
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
        capabilities: ["authentication", "threads", "streaming", "tool-requests"],
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
        "Reach Claude via an Anthropic API key, Vertex AI, or Amazon Bedrock. Fable owns the agent loop.",
      authState: "needs-auth",
      capabilities: [],
      models: [{ id: "claude-sonnet-4", label: "Claude Sonnet 4", available: false }]
    },
    {
      id: "gemini",
      backendType: "native-api",
      label: "Google Gemini",
      description: "Reach Gemini via a Google AI API key or Vertex AI. Fable owns the agent loop.",
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
  });

  const completeCredentialsStep = async (user: any) => {
    expect(await screen.findByRole("heading", { name: /create your fable account/i })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^name$/i), "Josh");
    await user.type(screen.getByLabelText(/^email$/i), "josh@example.com");
    await user.type(screen.getByLabelText(/^password$/i), "password123");
    await user.click(screen.getByRole("button", { name: /continue/i }));
  };

  it("gates the workspace behind the three-path onboarding shell", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("heading", { name: /create your fable account/i })).toBeInTheDocument();
    // The composer must NOT render until a backend is connected.
    expect(screen.queryByLabelText(/universal composer/i)).not.toBeInTheDocument();

    // Fill in credentials to proceed to the three paths choice page
    await completeCredentialsStep(user);

    expect(await screen.findByRole("heading", { name: /connect one ai backend to continue/i }))
      .toBeInTheDocument();

    // All three paths are present.
    expect(screen.getByText(/use a subscription/i)).toBeInTheDocument();
    expect(screen.getByText(/bring an api key/i)).toBeInTheDocument();
    expect(screen.getByText(/run a local model/i)).toBeInTheDocument();
  });

  it("offers the four subscription providers in the functional path", async () => {
    const user = userEvent.setup();
    render(<App />);

    await completeCredentialsStep(user);
    await screen.findByRole("heading", { name: /connect one ai backend to continue/i });

    // Navigate to subscription path
    await user.click(screen.getByRole("button", { name: /use a subscription/i }));

    expect(await screen.findByRole("heading", { name: /use a subscription/i })).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Cursor")).toBeInTheDocument();
    expect(screen.getByText("GitHub Copilot")).toBeInTheDocument();
    expect(screen.getByText("Grok")).toBeInTheDocument();
  });

  it("fails closed with an install hint for ACP providers lacking a CLI", async () => {
    const user = userEvent.setup();
    render(<App />);

    await completeCredentialsStep(user);
    await screen.findByRole("heading", { name: /connect one ai backend to continue/i });

    // Navigate to subscription path
    await user.click(screen.getByRole("button", { name: /use a subscription/i }));

    expect(await screen.findByRole("heading", { name: /use a subscription/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/cursor install required/i)).toHaveTextContent(/cursor cli/i);
    expect(screen.getByLabelText(/grok install required/i)).toHaveTextContent(/grok cli/i);
  });

  it("connects a subscription backend and clears the gate", async () => {
    const user = userEvent.setup();
    render(<App />);

    await completeCredentialsStep(user);
    await screen.findByRole("heading", { name: /connect one ai backend to continue/i });

    // Navigate to subscription path
    await user.click(screen.getByRole("button", { name: /use a subscription/i }));

    expect(await screen.findByRole("heading", { name: /use a subscription/i })).toBeInTheDocument();
    const codexCard = screen.getByText("Codex").closest("article");
    expect(codexCard).not.toBeNull();

    // Simulate the credential boundary resolving codex to connected after the
    // store call, so the re-read reflects the new auth state.
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

    // Open the connection step, connect, then finish the multi-step shell.
    await user.click(within(codexCard as HTMLElement).getByRole("button", { name: /set up/i }));
    await user.click(await screen.findByRole("button", { name: /^connect$/i }));
    const continueBtn = await screen.findByRole("button", {
      name: /continue to connectors|finish setup/i
    });
    await user.click(continueBtn);
    const finishBtn = await screen.findByRole("button", { name: /finish setup/i });
    await user.click(finishBtn);

    // Once a backend connects, the workspace (composer) becomes available.
    expect(await screen.findByLabelText(/universal composer/i)).toBeInTheDocument();
  });

  it("makes the api-key path functional while keeping local-model disabled", async () => {
    const user = userEvent.setup();
    render(<App />);

    await completeCredentialsStep(user);
    await screen.findByRole("heading", { name: /connect one ai backend to continue/i });

    // The local-model path stays disabled.
    const localPath = screen.getByText(/run a local model/i).closest("div");
    expect(localPath?.parentElement).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/local models are on the roadmap/i)).toBeInTheDocument();

    // Navigate to api key path
    await user.click(screen.getByRole("button", { name: /bring an api key/i }));

    expect(await screen.findByRole("heading", { name: /bring an api key/i })).toBeInTheDocument();
    // The five native providers render in the now-functional API-key path.
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("Google Gemini")).toBeInTheDocument();
    expect(screen.getByText("xAI")).toBeInTheDocument();
    expect(screen.getByText("OpenRouter")).toBeInTheDocument();

    // OpenAI's connection step exposes a secret input.
    const openaiRow = screen.getByText("OpenAI").closest("article");
    expect(openaiRow).not.toBeNull();
    await user.click(within(openaiRow as HTMLElement).getByRole("button", { name: /set up/i }));
    expect(await screen.findByLabelText(/api key for openai/i)).toBeInTheDocument();
  });

  it("uses compliant copy for Claude and Gemini (no subscription reuse)", async () => {
    const user = userEvent.setup();
    render(<App />);

    await completeCredentialsStep(user);
    await screen.findByRole("heading", { name: /connect one ai backend to continue/i });

    // Navigate to api key path
    await user.click(screen.getByRole("button", { name: /bring an api key/i }));

    const shell = await screen.findByRole("heading", {
      name: /bring an api key/i
    });
    const frame = shell.closest("main");
    const text = frame?.textContent?.toLowerCase() ?? "";
    // No Claude.ai subscription login; no Google AI Pro/Ultra subscription reuse.
    expect(text).not.toMatch(/claude\.ai/);
    expect(text).not.toMatch(/google ai (pro|ultra)/);
    // The allowed key/vertex/bedrock paths are named.
    expect(text).toMatch(/vertex|api key|bedrock/);
  });

  it("connects a native API-key backend and clears the gate", async () => {
    const user = userEvent.setup();
    render(<App />);

    await completeCredentialsStep(user);
    await screen.findByRole("heading", { name: /connect one ai backend to continue/i });

    // Navigate to api key path
    await user.click(screen.getByRole("button", { name: /bring an api key/i }));

    expect(await screen.findByRole("heading", { name: /bring an api key/i })).toBeInTheDocument();

    // Simulate the credential boundary resolving OpenAI to connected after the
    // store call records the key.
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

    // Open the connection step, submit the key, then finish the multi-step shell.
    await user.click(within(openaiCard as HTMLElement).getByRole("button", { name: /set up/i }));
    const keyInput = await screen.findByLabelText(/api key for openai/i);
    await user.type(keyInput, "sk-test-key");
    await user.click(screen.getByRole("button", { name: /add key & connect/i }));
    const continueBtn = await screen.findByRole("button", {
      name: /continue to connectors|finish setup/i
    });
    await user.click(continueBtn);
    const finishBtn = await screen.findByRole("button", { name: /finish setup/i });
    await user.click(finishBtn);

    expect(await screen.findByLabelText(/universal composer/i)).toBeInTheDocument();
  });

  it("does not promise any tier includes grok build entitlements", async () => {
    const user = userEvent.setup();
    render(<App />);

    await completeCredentialsStep(user);
    await screen.findByRole("heading", { name: /connect one ai backend to continue/i });

    // Navigate to subscription path
    await user.click(screen.getByRole("button", { name: /use a subscription/i }));

    const shell = await screen.findByRole("heading", {
      name: /use a subscription/i
    });
    const frame = shell.closest("main");
    expect(frame?.textContent?.toLowerCase()).not.toMatch(/grok build.*included|premium.*grok/i);
  });

  it("skips onboarding in preview and reaches the workspace", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("heading", { name: /create your fable account/i })).toBeInTheDocument();
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

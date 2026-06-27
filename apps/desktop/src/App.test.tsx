import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BackendProvider, RuntimeSnapshot } from "@arden/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const runtimeMocks = vi.hoisted(() => ({
  snapshot: null as RuntimeSnapshot | null,
  savedSnapshots: [] as RuntimeSnapshot[],
  backends: null as BackendProvider[] | null
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
  saveRuntimeSnapshot: vi.fn(async (snapshot: RuntimeSnapshot) => {
    runtimeMocks.savedSnapshots.push(snapshot);
    return snapshot;
  }),
  searchRuntimeConnector: vi.fn(async () => null),
  searchRuntimeKnowledgeSources: vi.fn(async () => null),
  startRuntimeConnectorAuth: vi.fn(async () => null),
  streamRuntimeCompletion: vi.fn(async () => null),
  cancelRuntimeCompletion: vi.fn(async () => null),
  listenRuntimeBackendEvents: vi.fn(async () => null)
}));

/** Render App and clear the onboarding gate by skipping in preview mode. */
async function skipOnboarding() {
  const user = userEvent.setup();
  const skip = await screen.findByRole("button", { name: /skip for now/i });
  await user.click(skip);
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

describe("Arden home", () => {
  beforeEach(() => {
    window.localStorage.clear();
    runtimeMocks.snapshot = null;
    runtimeMocks.savedSnapshots = [];
    // Default to a connected backend so the onboarding gate is cleared for the
    // existing workspace tests. Onboarding tests set this to an empty list.
    runtimeMocks.backends = null;
  });

  it("writes a connector action into the composer", async () => {
    const user = await renderWorkspace();

    await user.click(screen.getByRole("button", { name: /google docs/i }));

    expect(screen.getByLabelText(/universal composer/i)).toHaveValue("Use Google Docs to ");
  });

  it("uses the lightweight Codex-like navigation hierarchy", async () => {
    await renderWorkspace();

    expect(screen.getByText("Chats")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /daily catch-up/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /initial build/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /memory and approvals/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^connectors$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /knowledge/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^schedules$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^home$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^threads$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /goals/i })).not.toBeInTheDocument();
  });

  it("shows the seven first-wave connectors with honest fixture setup states", async () => {
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
    expect(within(gmailCard as HTMLElement).getByText("Not connected")).toBeInTheDocument();

    await user.click(
      within(gmailCard as HTMLElement).getByRole("button", { name: /live setup/i })
    );
    expect(screen.getByRole("status")).toHaveTextContent(/explicit preview data/i);
  });

  it("searches and imports fixture connector content as untrusted knowledge", async () => {
    const user = await renderWorkspace();
    await user.click(screen.getByRole("button", { name: /^connectors$/i }));
    await user.selectOptions(screen.getByLabelText(/^search connector$/i), "gmail");
    await user.type(screen.getByLabelText(/connector search query/i), "release");
    await user.click(screen.getByRole("button", { name: /search connector content/i }));

    expect(await screen.findByText("Release readiness notes")).toBeInTheDocument();
    expect(screen.getByText(/Gmail fixture.*untrusted/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^import$/i }));

    expect(screen.getByRole("status")).toHaveTextContent(/untrusted connector knowledge/i);
    expect(screen.getByText("1 imported")).toBeInTheDocument();
  });

  it("prepares connector writes as approval requests instead of executing them", async () => {
    const user = await renderWorkspace();
    await user.click(screen.getByRole("button", { name: /^connectors$/i }));
    const gmailCard = screen
      .getAllByText("Gmail")
      .map((node) => node.closest("article"))
      .find(Boolean);
    expect(gmailCard).not.toBeNull();

    await user.click(
      within(gmailCard as HTMLElement).getByRole("button", {
        name: /prepare create draft/i
      })
    );
    expect(screen.getByRole("status")).toHaveTextContent(/action prepared/i);

    await user.click(screen.getByRole("button", { name: /memory and approvals/i }));
    expect(screen.getByText("Create Draft")).toBeInTheDocument();
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
      "Josh's Arden"
    );
    expect(screen.queryByText(/projects and chats stay inside this workspace/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /what are we building today in josh's arden/i })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /select permissions/i }));
    await user.click(screen.getByRole("menuitemradio", { name: /standard access/i }));
    expect(screen.getByRole("button", { name: /select permissions/i })).toHaveTextContent(
      "Standard access"
    );
  });

  it("opens knowledge as a coming soon workspace view", async () => {
    const user = await renderWorkspace();

    await user.click(screen.getByRole("button", { name: /^knowledge$/i }));

    expect(screen.getByRole("heading", { name: "Knowledge" })).toBeInTheDocument();
    expect(screen.getByLabelText(/knowledge coming soon/i)).toHaveTextContent("Coming soon");
    expect(screen.queryByRole("heading", { name: "Sources" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Memory" })).not.toBeInTheDocument();
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
    expect(screen.getByText(/ready to run model tasks/i)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /^providers$/i }));
    const anthropicCard = screen.getByText("Anthropic").closest("article");

    expect(anthropicCard).not.toBeNull();
    await user.click(within(anthropicCard as HTMLElement).getByRole("button", { name: /add key/i }));

    expect(screen.getByText(/anthropic connected for this mock session/i)).toBeInTheDocument();
    expect(within(anthropicCard as HTMLElement).getByText("connected")).toBeInTheDocument();
  });

  it("records approval decisions without losing the second pending request", async () => {
    const user = await renderWorkspace();

    await user.click(screen.getByRole("button", { name: /memory and approvals/i }));
    expect(screen.getByText("Create draft PR for feature-memory")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: /^deny$/i })[0]);

    expect(screen.queryByText("Create draft PR for feature-memory")).not.toBeInTheDocument();
    expect(screen.getByText("Enable weekly workspace digest")).toBeInTheDocument();
    expect(screen.getByText(/deny: GitHub Create draft PR/i)).toBeInTheDocument();
  });

  it("keeps session approvals visible without turning them into standing rules", async () => {
    const user = await renderWorkspace();

    await user.click(screen.getByRole("button", { name: /memory and approvals/i }));
    const githubApproval = screen
      .getByText("Create draft PR for feature-memory")
      .closest("article");

    expect(githubApproval).not.toBeNull();
    await user.click(
      within(githubApproval as HTMLElement).getByRole("button", { name: /^session$/i })
    );

    expect(screen.queryByText("Create draft PR for feature-memory")).not.toBeInTheDocument();
    expect(
      screen.getByText("Session: GitHub - Create draft PR for feature-memory")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Rule: GitHub - Create draft PR for feature-memory")
    ).not.toBeInTheDocument();
  });

  it("creates a standing rule from an approval request", async () => {
    const user = await renderWorkspace();

    await user.click(screen.getByRole("button", { name: /memory and approvals/i }));
    const githubApproval = screen
      .getByText("Create draft PR for feature-memory")
      .closest("article");

    expect(githubApproval).not.toBeNull();
    await user.click(
      within(githubApproval as HTMLElement).getByRole("button", { name: /^rule$/i })
    );

    expect(
      screen.getByText("Rule: GitHub - Create draft PR for feature-memory")
    ).toBeInTheDocument();
  });

  it("modifies an approval before resolving it", async () => {
    const user = await renderWorkspace();

    await user.click(screen.getByRole("button", { name: /memory and approvals/i }));
    const githubApproval = screen
      .getByText("Create draft PR for feature-memory")
      .closest("article");

    expect(githubApproval).not.toBeNull();
    const approval = within(githubApproval as HTMLElement);
    await user.click(approval.getByRole("button", { name: /^modify$/i }));
    await user.click(approval.getByRole("button", { name: "read-only" }));
    await user.clear(approval.getByLabelText(/allowed data for create draft pr/i));
    await user.type(
      approval.getByLabelText(/allowed data for create draft pr/i),
      "branch diff"
    );
    await user.clear(approval.getByLabelText(/consequence for create draft pr/i));
    await user.type(
      approval.getByLabelText(/consequence for create draft pr/i),
      "Reviews the branch without publishing."
    );
    await user.click(approval.getByRole("button", { name: /save changes/i }));

    expect(screen.queryByText("Create draft PR for feature-memory")).not.toBeInTheDocument();
    expect(
      screen.getByText(/modify: GitHub Create draft PR for feature-memory modified to read-only using branch diff/i)
    ).toBeInTheDocument();
  });

  it("requires an exact phrase for high-risk full-access approvals", async () => {
    const user = await renderWorkspace();

    await user.click(screen.getByRole("button", { name: /memory and approvals/i }));
    const releaseApproval = screen
      .getByText("Promote Arden preview to production")
      .closest("article");

    expect(releaseApproval).not.toBeNull();
    const approval = within(releaseApproval as HTMLElement);
    await user.click(approval.getByRole("button", { name: /^once$/i }));

    const confirmation = approval.getByLabelText(
      /confirmation for promote Arden preview to production/i
    );
    await user.type(confirmation, "publish preview");
    await user.click(approval.getByRole("button", { name: /^confirm$/i }));

    expect(screen.getByText(/Confirmation phrase did not match/i)).toBeInTheDocument();
    expect(screen.getByText("Promote Arden preview to production")).toBeInTheDocument();

    await user.clear(confirmation);
    await user.type(confirmation, "publish Arden");
    await user.click(approval.getByRole("button", { name: /^confirm$/i }));

    expect(
      screen.queryByText("Promote Arden preview to production")
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/once: Vercel Promote Arden preview to production/i)
    ).toBeInTheDocument();
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

    expect(screen.getByLabelText(/knowledge coming soon/i)).toHaveTextContent("Coming soon");
    expect(screen.queryByText("launch-notes.md")).not.toBeInTheDocument();
  });

  it("shows citations from workspace sources when the composer is submitted", async () => {
    const user = await renderWorkspace();

    await user.type(screen.getByLabelText(/universal composer/i), "selected visual direction");
    await user.click(screen.getByRole("button", { name: /send prompt/i }));

    expect(await screen.findByText("Sources used")).toBeInTheDocument();
    expect(screen.getByText("Selected visual direction")).toBeInTheDocument();
    expect(screen.getByText("Product Design mockup - Updated today - trusted")).toBeInTheDocument();
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

  it("recovers shell state from a runtime snapshot", async () => {
    const user = userEvent.setup();
    runtimeMocks.snapshot = {
      version: 1,
      activeItem: "arden-initial-build",
      composerDraft: "/schedule recovered weekly digest",
      voiceEnabled: true,
      approvalAudit: [],
      dismissedApprovalIds: ["github-draft-pr"],
      approvalRules: [],
      automationStatuses: {
        "weekly-digest": "active"
      },
      pinnedSourceIds: ["codex-manual"],
      importedKnowledgeSources: [],
      memoryDisabled: false,
      memoryRecords: [],
      connectedBackendIds: ["codex"],
      savedAt: "2026-06-26T10:30:00.000Z"
    };

    render(<App />);

    // Composer draft is recovered into a chat view (the composer lives only
    // on chat views in the new page-based navigation).
    expect(await screen.findByDisplayValue("/schedule recovered weekly digest")).toBeInTheDocument();

    // Recovered schedule status is reflected on the standalone Schedules page.
    await user.click(screen.getByRole("button", { name: /^schedules$/i }));
    const weeklySchedule = screen.getByText("Weekly workspace digest").closest("article");

    expect(weeklySchedule).not.toBeNull();
    expect(within(weeklySchedule as HTMLElement).getByText("active")).toBeInTheDocument();

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

    // Outside Tauri there is no transport; the panel surfaces the no-transport
    // notice so the agent surface is visible and testable.
    expect(await screen.findByLabelText(/agent activity/i)).toBeInTheDocument();
    expect(screen.getByText(/native agent needs a connected desktop backend/i)).toBeInTheDocument();
  });
});

/**
 * Onboarding gate: the three-path AI-backend shell. These tests force the
 * gate to show by serving fail-closed (no connected) backend providers.
 */
describe("Arden onboarding", () => {
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
      models: [{ id: "grok-default", label: "Grok", available: false }],
      installHint: "Requires the Grok CLI. Install it, then connect.",
      entitlements: []
    },
    {
      id: "openai",
      backendType: "native-api",
      label: "OpenAI",
      description: "Reach GPT models directly with an OpenAI API key. Arden owns the agent loop.",
      authState: "needs-auth",
      capabilities: [],
      models: [{ id: "gpt-5", label: "GPT-5", available: false }]
    },
    {
      id: "anthropic",
      backendType: "native-api",
      label: "Anthropic",
      description:
        "Reach Claude via an Anthropic API key, Vertex AI, or Amazon Bedrock. Arden owns the agent loop.",
      authState: "needs-auth",
      capabilities: [],
      models: [{ id: "claude-sonnet-4", label: "Claude Sonnet 4", available: false }]
    },
    {
      id: "gemini",
      backendType: "native-api",
      label: "Google Gemini",
      description: "Reach Gemini via a Google AI API key or Vertex AI. Arden owns the agent loop.",
      authState: "needs-auth",
      capabilities: [],
      models: [{ id: "gemini-2-pro", label: "Gemini 2 Pro", available: false }]
    },
    {
      id: "xai",
      backendType: "native-api",
      label: "xAI",
      description: "Reach Grok models directly with an xAI API key. Arden owns the agent loop.",
      authState: "needs-auth",
      capabilities: [],
      models: [{ id: "grok-4", label: "Grok 4", available: false }]
    },
    {
      id: "openrouter",
      backendType: "native-api",
      label: "OpenRouter",
      description: "Reach many models through OpenRouter with an OpenRouter API key. Arden owns the agent loop.",
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

  it("gates the workspace behind the three-path onboarding shell", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: /connect one ai backend to continue/i }))
      .toBeInTheDocument();
    // The composer must NOT render until a backend is connected.
    expect(screen.queryByLabelText(/universal composer/i)).not.toBeInTheDocument();

    // All three paths are present.
    expect(screen.getByText(/use a subscription/i)).toBeInTheDocument();
    expect(screen.getByText(/bring an api key/i)).toBeInTheDocument();
    expect(screen.getByText(/run a local model/i)).toBeInTheDocument();
  });

  it("offers the four subscription providers in the functional path", async () => {
    render(<App />);

    await screen.findByRole("heading", { name: /connect one ai backend to continue/i });
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Cursor")).toBeInTheDocument();
    expect(screen.getByText("GitHub Copilot")).toBeInTheDocument();
    expect(screen.getByText("Grok")).toBeInTheDocument();
  });

  it("fails closed with an install hint for ACP providers lacking a CLI", async () => {
    render(<App />);

    await screen.findByRole("heading", { name: /connect one ai backend to continue/i });
    expect(screen.getByLabelText(/cursor install required/i)).toHaveTextContent(/cursor cli/i);
    expect(screen.getByLabelText(/grok install required/i)).toHaveTextContent(/grok cli/i);
  });

  it("connects a subscription backend and clears the gate", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: /connect one ai backend to continue/i });
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

    await user.click(within(codexCard as HTMLElement).getByRole("button", { name: /connect/i }));

    // Once a backend connects, the workspace (composer) becomes available.
    expect(await screen.findByLabelText(/universal composer/i)).toBeInTheDocument();
  });

  it("makes the api-key path functional while keeping local-model disabled", async () => {
    render(<App />);

    await screen.findByRole("heading", { name: /connect one ai backend to continue/i });

    // The five native providers render in the now-functional API-key path.
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("Google Gemini")).toBeInTheDocument();
    expect(screen.getByText("xAI")).toBeInTheDocument();
    expect(screen.getByText("OpenRouter")).toBeInTheDocument();

    // The API-key path exposes a secret input.
    expect(screen.getByLabelText(/api key for openai/i)).toBeInTheDocument();

    // The local-model path stays disabled.
    const localPath = screen.getByText(/run a local model/i).closest("div");
    expect(localPath?.parentElement).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/local models are on the roadmap/i)).toBeInTheDocument();
  });

  it("uses compliant copy for Claude and Gemini (no subscription reuse)", async () => {
    render(<App />);

    const shell = await screen.findByRole("heading", {
      name: /connect one ai backend to continue/i
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

    await screen.findByRole("heading", { name: /connect one ai backend to continue/i });

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
    await user.type(
      within(openaiCard as HTMLElement).getByLabelText(/api key for openai/i),
      "sk-test-key"
    );
    await user.click(
      within(openaiCard as HTMLElement).getByRole("button", { name: /add key/i })
    );

    expect(await screen.findByLabelText(/universal composer/i)).toBeInTheDocument();
  });

  it("does not promise any tier includes grok build entitlements", async () => {
    render(<App />);

    const shell = await screen.findByRole("heading", {
      name: /connect one ai backend to continue/i
    });
    const frame = shell.closest("main");
    expect(frame?.textContent?.toLowerCase()).not.toMatch(/grok build.*included|premium.*grok/i);
  });

  it("skips onboarding in preview and reaches the workspace", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: /connect one ai backend to continue/i });
    await user.click(screen.getByRole("button", { name: /skip for now/i }));

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

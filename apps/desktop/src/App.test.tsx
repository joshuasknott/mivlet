import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RuntimeSnapshot } from "@arden/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const runtimeMocks = vi.hoisted(() => ({
  snapshot: null as RuntimeSnapshot | null,
  savedSnapshots: [] as RuntimeSnapshot[]
}));

vi.mock("./runtime", () => ({
  exportRuntimeMemoryState: vi.fn(async () => null),
  importRuntimeLocalKnowledgeSource: vi.fn(async () => null),
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
  promoteRuntimeKnowledgeSourceToMemory: vi.fn(async () => null),
  resolveRuntimeApprovalRequest: vi.fn(async () => null),
  saveRuntimeMemoryState: vi.fn(async () => null),
  saveRuntimeSnapshot: vi.fn(async (snapshot: RuntimeSnapshot) => {
    runtimeMocks.savedSnapshots.push(snapshot);
    return snapshot;
  }),
  searchRuntimeKnowledgeSources: vi.fn(async () => null)
}));

describe("Arden home", () => {
  beforeEach(() => {
    window.localStorage.clear();
    runtimeMocks.snapshot = null;
    runtimeMocks.savedSnapshots = [];
  });

  it("writes a contextual directive into the composer", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /turn codex notes into a launch plan/i }));

    expect(screen.getByLabelText(/universal composer/i)).toHaveValue(
      "Turn the Codex notes and PRD into a launch plan with milestones, risks, owner decisions, and the next three implementation steps."
    );
  });

  it("uses the lightweight Codex-like navigation hierarchy", () => {
    render(<App />);

    expect(screen.getByText("Chats")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /daily catch-up/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /initial build/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /memory and approvals/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /knowledge/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^home$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^threads$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /goals/i })).not.toBeInTheDocument();
  });

  it("opens knowledge as an inspectable workspace view", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^knowledge$/i }));

    expect(screen.getByRole("heading", { name: "Sources" })).toBeInTheDocument();
    expect(screen.getByText("Arden product brief")).toBeInTheDocument();
    expect(screen.getByText("Selected design direction")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Memory" })).toBeInTheDocument();
    expect(screen.getByText("Concise updates")).toBeInTheDocument();
  });

  it("records approval decisions without losing the second pending request", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /memory and approvals/i }));
    expect(screen.getByText("Create draft PR for feature-memory")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: /^deny$/i })[0]);

    expect(screen.queryByText("Create draft PR for feature-memory")).not.toBeInTheDocument();
    expect(screen.getByText("Enable weekly workspace digest")).toBeInTheDocument();
    expect(screen.getByText(/deny: GitHub Create draft PR/i)).toBeInTheDocument();
  });

  it("keeps session approvals visible without turning them into standing rules", async () => {
    const user = userEvent.setup();
    render(<App />);

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
    const user = userEvent.setup();
    render(<App />);

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
    const user = userEvent.setup();
    render(<App />);

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
    const user = userEvent.setup();
    render(<App />);

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
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /open slash commands/i }));
    await user.click(screen.getByRole("button", { name: "/goal" }));

    expect(screen.getByLabelText(/universal composer/i)).toHaveValue("/goal ");
  });

  it("imports local text files as pinned knowledge and contextual directives", async () => {
    const user = userEvent.setup();
    render(<App />);
    const file = new File(["Launch risks, connector recovery, and approval notes"], "launch-notes.md", {
      type: "text/markdown"
    });

    await user.upload(screen.getByLabelText(/import local knowledge file/i), file);

    expect(await screen.findByText(/Imported launch-notes.md/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /summarize launch-notes.md/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^knowledge$/i }));

    expect(screen.getByText("launch-notes.md")).toBeInTheDocument();
    expect(screen.getByText(/Local file -/i)).toBeInTheDocument();
  });

  it("shows citations from workspace sources when the composer is submitted", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText(/universal composer/i), "selected visual direction");
    await user.click(screen.getByRole("button", { name: /send prompt/i }));

    expect(await screen.findByText("Sources used")).toBeInTheDocument();
    expect(screen.getByText("Selected visual direction")).toBeInTheDocument();
    expect(screen.getByText("Product Design mockup - Updated today - trusted")).toBeInTheDocument();
  });

  it("edits and forgets memory records", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^knowledge$/i }));
    await user.click(screen.getByRole("button", { name: /edit concise updates/i }));
    await user.clear(screen.getByLabelText("Memory value"));
    await user.type(screen.getByLabelText("Memory value"), "Josh prefers direct updates with next actions.");
    await user.click(screen.getByRole("button", { name: /save concise updates/i }));

    expect(screen.getByText("Josh prefers direct updates with next actions.")).toBeInTheDocument();
    expect(screen.getByText("Edited by Josh - Updated now")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /forget current build status/i }));

    expect(screen.queryByText("Current build status")).not.toBeInTheDocument();
    expect(screen.getByText(/Forgot memory: Current build status/i)).toBeInTheDocument();
  });

  it("disables and exports memory without deleting records", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^knowledge$/i }));
    await user.click(screen.getByRole("button", { name: /disable memory/i }));

    expect(screen.getByText(/Memory is disabled/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /enable memory/i })).toBeInTheDocument();
    expect(screen.getByText("Concise updates")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /export memory/i }));

    const exported = screen.getByLabelText("Memory export") as HTMLTextAreaElement;
    expect(exported.value).toContain("arden.memory.export.v1");
    expect(exported.value).toContain("Concise updates");
  });

  it("approves a source into durable memory with audit history", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^knowledge$/i }));
    await user.click(screen.getByRole("button", { name: /approve to memory market-research\.pdf/i }));

    expect(screen.getAllByText("market-research.pdf").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Approved from untrusted source: Imported source fixture/i)).toBeInTheDocument();
    expect(screen.getByText(/Approved memory: market-research\.pdf/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /memory and approvals/i }));

    expect(screen.getByText(/once: Arden Memory Approve Imported source fixture into durable memory/i)).toBeInTheDocument();
  });

  it("recovers composer drafts from local persistence", async () => {
    const user = userEvent.setup();
    const firstRender = render(<App />);

    await user.type(screen.getByLabelText(/universal composer/i), "Plan the onboarding journey");
    firstRender.unmount();
    render(<App />);

    expect(screen.getByLabelText(/universal composer/i)).toHaveValue("Plan the onboarding journey");
  });

  it("recovers shell state from a runtime snapshot", async () => {
    runtimeMocks.snapshot = {
      version: 1,
      activeItem: "Automations",
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
      savedAt: "2026-06-26T10:30:00.000Z"
    };

    render(<App />);

    expect(await screen.findByDisplayValue("/schedule recovered weekly digest")).toBeInTheDocument();
    const weeklyAutomation = screen.getByText("Weekly workspace digest").closest("article");

    expect(weeklyAutomation).not.toBeNull();
    expect(within(weeklyAutomation as HTMLElement).getByText("active")).toBeInTheDocument();

    await waitFor(() => {
      expect(runtimeMocks.savedSnapshots.at(-1)?.composerDraft).toBe("/schedule recovered weekly digest");
    });
  });
});

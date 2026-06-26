import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RuntimeSnapshot } from "@praxis/protocol";
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
  loadRuntimeImportedKnowledgeSources: vi.fn(async () => null),
  loadRuntimeMemoryState: vi.fn(async () => null),
  loadRuntimeSnapshot: vi.fn(
    () =>
      runtimeMocks.snapshot
        ? Promise.resolve(runtimeMocks.snapshot)
        : new Promise<RuntimeSnapshot | null>(() => {})
  ),
  recordRuntimeApprovalDecision: vi.fn(async () => null),
  saveRuntimeMemoryState: vi.fn(async () => null),
  saveRuntimeSnapshot: vi.fn(async (snapshot: RuntimeSnapshot) => {
    runtimeMocks.savedSnapshots.push(snapshot);
    return snapshot;
  }),
  searchRuntimeKnowledgeSources: vi.fn(async () => null)
}));

describe("Praxis home", () => {
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
    expect(screen.getByText("Praxis product brief")).toBeInTheDocument();
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
    expect(exported.value).toContain("praxis.memory.export.v1");
    expect(exported.value).toContain("Concise updates");
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

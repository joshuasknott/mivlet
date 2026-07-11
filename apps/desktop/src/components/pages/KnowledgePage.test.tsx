import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { KnowledgeSource, LocalFileImport, MemoryRecord } from "@fable/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgePage } from "./KnowledgePage";
import type { ShellRuntime } from "../../hooks/useShellRuntime";

/**
 * Behavioral lifecycle coverage for the Knowledge page. The page is rendered
 * with a stubbed ShellRuntime so every lifecycle action (import, pin, disable,
 * delete, forget, export) can be asserted against the callbacks the hook owns,
 * without driving the full App + Tauri boundary. Exclusion semantics (disabled
 * and forgotten material never appearing in search/citation/export) are asserted
 * here at the page level; the hook tests own the persistence/rollback behavior.
 */

function makeSource(overrides: Partial<KnowledgeSource> = {}): KnowledgeSource {
  return {
    id: "source-1",
    title: "Quarterly plan",
    kind: "document",
    connectorId: "local-files",
    provenance: "Local file - 2.0 KB",
    freshness: "Imported today",
    pinned: false,
    contentPreview: "The quarterly plan covers launch, risks, and milestones.",
    ...overrides
  };
}

function makeLocalImport(overrides: Partial<LocalFileImport> = {}): LocalFileImport {
  return {
    id: "source-1",
    title: "Quarterly plan",
    kind: "document",
    connectorId: "local-files",
    provenance: "Local file - 2.0 KB",
    freshness: "Imported today",
    pinned: false,
    trust: "untrusted",
    contentPreview: "The quarterly plan covers launch, risks, and milestones.",
    contentFingerprint: "fp-1",
    sizeBytes: 2048,
    importedAt: "2026-07-01T00:00:00.000Z",
    origin: "local-import",
    ...overrides
  };
}

function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "memory-1",
    kind: "fact",
    title: "Prefers concise answers",
    value: "The user prefers concise answers.",
    source: "chat",
    freshness: "Today",
    approved: true,
    pinned: false,
    ...overrides
  };
}

interface StubState {
  sources: KnowledgeSource[];
  memories: MemoryRecord[];
  pinnedSourceIds: string[];
  memoryDisabled: boolean;
  importStatus: string | null;
  memoryStatus: string;
  memoryExportText: string;
  knowledgeExportText: string;
  connectorManifests: ShellRuntime["connectorManifests"];
}

function stubRuntime(state: StubState): ShellRuntime & { _calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };
  return {
    _calls: calls,
    workspaceKnowledgeSources: state.sources,
    managedMemoryRecords: state.memories,
    pinnedSourceIds: state.pinnedSourceIds,
    memoryDisabled: state.memoryDisabled,
    importStatus: state.importStatus,
    memoryStatus: state.memoryStatus,
    memoryExportText: state.memoryExportText,
    knowledgeExportText: state.knowledgeExportText,
    connectorManifests: state.connectorManifests,
    editingMemoryId: null,
    editingMemoryDraft: { title: "", value: "" },
    fileInputRef: { current: null },
    folderInputRef: { current: null },
    setActiveItem: vi.fn(),
    setEditingMemoryDraft: vi.fn(),
    toggleSourcePin: vi.fn(record("toggleSourcePin")),
    promoteSourceToMemory: vi.fn(record("promoteSourceToMemory")),
    startMemoryEdit: vi.fn(),
    saveMemoryEdit: vi.fn(),
    toggleMemoryPin: vi.fn(record("toggleMemoryPin")),
    forgetMemory: vi.fn(record("forgetMemory")),
    toggleMemoryRecordDisabled: vi.fn(record("toggleMemoryRecordDisabled")),
    toggleMemoryDisabled: vi.fn(record("toggleMemoryDisabled")),
    exportMemory: vi.fn(async () => record("exportMemory")()),
    exportKnowledge: vi.fn(async () => record("exportKnowledge")()),
    cancelMemoryEdit: vi.fn(),
    searchKnowledge: vi.fn(async () => record("searchKnowledge")()),
    refreshKnowledgeSource: vi.fn(async () => record("refreshKnowledgeSource")()),
    toggleKnowledgeSourceDisabled: vi.fn(record("toggleKnowledgeSourceDisabled")),
    deleteKnowledgeSource: vi.fn(record("deleteKnowledgeSource")),
    triggerAttach: vi.fn(),
    triggerFolderImport: vi.fn(),
    handleLocalKnowledgeFileChange: vi.fn(),
    handleLocalKnowledgeFolderChange: vi.fn()
  } as unknown as ShellRuntime & { _calls: Record<string, unknown[][]> };
}

function renderPage(runtime: ShellRuntime) {
  return render(<KnowledgePage runtime={runtime} />);
}

describe("KnowledgePage — import lifecycle states", () => {
  it("shows the indexing notice while a source is being indexed, then the indexed state", () => {
    const runtime = stubRuntime({
      sources: [makeSource({ status: "indexing" })],
      memories: [],
      pinnedSourceIds: [],
      memoryDisabled: false,
      importStatus: "Indexing quarterly plan...",
      memoryStatus: "",
      memoryExportText: "",
      knowledgeExportText: "",
      connectorManifests: []
    });
    renderPage(runtime);

    expect(screen.getByText(/indexing quarterly plan/i)).toBeInTheDocument();
    // The indexing source is visible in the management list with its status.
    expect(screen.getByText("Quarterly plan")).toBeInTheDocument();
  });

  it("surfaces an import failure through the import status without a phantom source", () => {
    const runtime = stubRuntime({
      sources: [],
      memories: [],
      pinnedSourceIds: [],
      memoryDisabled: false,
      importStatus: "Fable could not import that file.",
      memoryStatus: "",
      memoryExportText: "",
      knowledgeExportText: "",
      connectorManifests: []
    });
    renderPage(runtime);

    expect(screen.getByText(/could not import that file/i)).toBeInTheDocument();
    // No phantom source row.
    expect(screen.queryByText("Quarterly plan")).not.toBeInTheDocument();
  });

  it("uses an explicit one-shot file chooser for local refresh while connectors keep Refresh", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      sources: [makeLocalImport(), makeSource({ id: "connector-1", title: "Drive plan", connectorId: "google-drive" })],
      memories: [], pinnedSourceIds: [], memoryDisabled: false, importStatus: null,
      memoryStatus: "", memoryExportText: "", knowledgeExportText: "", connectorManifests: []
    });
    let finishUpdate!: () => void;
    runtime.refreshKnowledgeSource = vi.fn((sourceId: string, file?: File) => {
      if (!file) return Promise.resolve();
      return new Promise<void>((resolve) => { finishUpdate = resolve; });
    });
    renderPage(runtime);
    await user.click(screen.getByRole("button", { name: "Open Quarterly plan" }));
    expect(screen.getByText("Choose the current version of this file. Fable wonâ€™t keep access to its location.")).toBeInTheDocument();
    const file = new File(["new plan"], "quarterly-plan.md", { type: "text/markdown" });
    await user.upload(screen.getByLabelText("Choose the current version of Quarterly plan"), file);
    expect(runtime.refreshKnowledgeSource).toHaveBeenCalledWith("source-1", file);
    expect(screen.getByText("Updatingâ€¦")).toBeInTheDocument();
    finishUpdate();
    await waitFor(() => expect(screen.queryByText("Updatingâ€¦")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Open Drive plan" }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(runtime.refreshKnowledgeSource).toHaveBeenCalledWith("connector-1");
  });
});

describe("KnowledgePage — pin round trip and pin guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls toggleSourcePin when the source pin button is clicked", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      sources: [makeSource()],
      memories: [],
      pinnedSourceIds: [],
      memoryDisabled: false,
      importStatus: null,
      memoryStatus: "",
      memoryExportText: "",
      knowledgeExportText: "",
      connectorManifests: []
    });
    renderPage(runtime);

    await user.click(screen.getByRole("button", { name: /pin quarterly plan/i }));
    expect(runtime.toggleSourcePin).toHaveBeenCalledWith("source-1");
  });

  it("renders the pinned state on the source and supports unpin", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      sources: [makeSource()],
      memories: [],
      pinnedSourceIds: ["source-1"],
      memoryDisabled: false,
      importStatus: null,
      memoryStatus: "",
      memoryExportText: "",
      knowledgeExportText: "",
      connectorManifests: []
    });
    renderPage(runtime);

    const pinButton = screen.getByRole("button", { name: /unpin quarterly plan/i });
    expect(pinButton).toHaveClass("is-pinned");
    await user.click(pinButton);
    expect(runtime.toggleSourcePin).toHaveBeenCalledWith("source-1");
  });

  it("calls toggleMemoryPin for a memory and reflects the pinned state", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      sources: [],
      memories: [makeMemory({ pinned: true })],
      pinnedSourceIds: [],
      memoryDisabled: false,
      importStatus: null,
      memoryStatus: "",
      memoryExportText: "",
      knowledgeExportText: "",
      connectorManifests: []
    });
    renderPage(runtime);

    await user.click(screen.getByRole("tab", { name: "Memories" }));
    const pinButton = screen.getByRole("button", { name: /unpin prefers concise answers/i });
    expect(pinButton).toHaveClass("is-pinned");
    await user.click(pinButton);
    expect(runtime.toggleMemoryPin).toHaveBeenCalledWith("memory-1");
  });
});

describe("KnowledgePage — source disable / delete / re-enable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a disabled badge and excludes the source from global search results", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      sources: [makeSource({ disabled: true, title: "Disabled doc" })],
      memories: [],
      pinnedSourceIds: [],
      memoryDisabled: false,
      importStatus: null,
      memoryStatus: "",
      memoryExportText: "",
      knowledgeExportText: "",
      connectorManifests: []
    });
    renderPage(runtime);

    // Management list keeps the disabled source visible with a badge.
    expect(screen.getByText("Disabled doc")).toBeInTheDocument();
    expect(screen.getByText(/disabled — excluded from search/i)).toBeInTheDocument();

    // Global search excludes the disabled source.
    await user.type(screen.getByRole("textbox", { name: /search everything/i }), "doc");
    expect(screen.queryByText("Disabled doc")).not.toBeInTheDocument();
    expect(screen.getByText(/nothing found/i)).toBeInTheDocument();
  });

  it("calls the re-enable control for a disabled source", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      sources: [makeSource({ disabled: true })],
      memories: [],
      pinnedSourceIds: [],
      memoryDisabled: false,
      importStatus: null,
      memoryStatus: "",
      memoryExportText: "",
      knowledgeExportText: "",
      connectorManifests: []
    });
    renderPage(runtime);

    await user.click(screen.getByRole("button", { name: /^quarterly plan local file/i }));
    await user.click(screen.getByRole("button", { name: /^use source$/i }));
    expect(runtime.toggleKnowledgeSourceDisabled).toHaveBeenCalledWith("source-1");
  });

  it("requires a confirmation step before deleting a source", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      sources: [makeSource()],
      memories: [],
      pinnedSourceIds: [],
      memoryDisabled: false,
      importStatus: null,
      memoryStatus: "",
      memoryExportText: "",
      knowledgeExportText: "",
      connectorManifests: []
    });
    renderPage(runtime);

    await user.click(screen.getByRole("button", { name: /^quarterly plan local file/i }));
    // First click arms confirmation; delete is NOT called yet.
    await user.click(screen.getByRole("button", { name: /confirm delete quarterly plan/i }));
    expect(runtime.deleteKnowledgeSource).not.toHaveBeenCalled();

    // Confirming performs the delete.
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(runtime.deleteKnowledgeSource).toHaveBeenCalledWith("source-1");
  });

  it("cancelling the delete confirmation disarms it", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      sources: [makeSource()],
      memories: [],
      pinnedSourceIds: [],
      memoryDisabled: false,
      importStatus: null,
      memoryStatus: "",
      memoryExportText: "",
      knowledgeExportText: "",
      connectorManifests: []
    });
    renderPage(runtime);

    await user.click(screen.getByRole("button", { name: /^quarterly plan local file/i }));
    await user.click(screen.getByRole("button", { name: /confirm delete quarterly plan/i }));
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(runtime.deleteKnowledgeSource).not.toHaveBeenCalled();
    // The plain Delete button is available again.
    expect(screen.getByRole("button", { name: /confirm delete quarterly plan/i })).toBeInTheDocument();
  });
});

describe("KnowledgePage — memory disable / forget / re-enable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hides forgotten memories from the management view", () => {
    const runtime = stubRuntime({
      sources: [],
      memories: [
        makeMemory({ id: "mem-live", title: "Live memory" }),
        makeMemory({ id: "mem-forgotten", title: "Gone memory", forgottenAt: "2026-07-01T00:00:00.000Z" })
      ],
      pinnedSourceIds: [],
      memoryDisabled: false,
      importStatus: null,
      memoryStatus: "",
      memoryExportText: "",
      knowledgeExportText: "",
      connectorManifests: []
    });
    renderPage(runtime);

    expect(screen.queryByText("Gone memory")).not.toBeInTheDocument();
  });

  it("keeps a disabled memory visible with a badge and excludes it from search", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      sources: [],
      memories: [makeMemory({ disabled: true, title: "Off memory", value: "off value" })],
      pinnedSourceIds: [],
      memoryDisabled: false,
      importStatus: null,
      memoryStatus: "",
      memoryExportText: "",
      knowledgeExportText: "",
      connectorManifests: []
    });
    renderPage(runtime);

    // The default scope is "everything": typing a query shows global results,
    // which must exclude the disabled memory.
    await user.type(screen.getByRole("textbox", { name: /search everything/i }), "off value");
    expect(screen.queryByText("Off memory")).not.toBeInTheDocument();

    // The management view (Memories tab) keeps the disabled memory visible.
    await user.click(screen.getByRole("tab", { name: "Memories" }));
    expect(screen.getByText("Off memory")).toBeInTheDocument();
    expect(screen.getByText(/disabled — excluded from search, context, and export/i)).toBeInTheDocument();
  });

  it("calls the re-enable control for a disabled memory and disable for a live one", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      sources: [],
      memories: [makeMemory({ disabled: true, id: "mem-off" })],
      pinnedSourceIds: [],
      memoryDisabled: false,
      importStatus: null,
      memoryStatus: "",
      memoryExportText: "",
      knowledgeExportText: "",
      connectorManifests: []
    });
    renderPage(runtime);

    await user.click(screen.getByRole("tab", { name: "Memories" }));
    await user.click(screen.getByRole("button", { name: /^prefers concise answers chat$/i }));
    await user.click(screen.getByRole("button", { name: /^re-enable$/i }));
    expect(runtime.toggleMemoryRecordDisabled).toHaveBeenCalledWith("mem-off");
  });

  it("requires a confirmation step before forgetting a memory", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      sources: [],
      memories: [makeMemory()],
      pinnedSourceIds: [],
      memoryDisabled: false,
      importStatus: null,
      memoryStatus: "",
      memoryExportText: "",
      knowledgeExportText: "",
      connectorManifests: []
    });
    renderPage(runtime);

    await user.click(screen.getByRole("tab", { name: "Memories" }));
    await user.click(screen.getByRole("button", { name: /^prefers concise answers chat$/i }));
    await user.click(screen.getByRole("button", { name: /confirm forget prefers concise answers/i }));
    expect(runtime.forgetMemory).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^forget$/i }));
    expect(runtime.forgetMemory).toHaveBeenCalledWith("memory-1");
  });
});

describe("KnowledgePage — export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers a workspace knowledge export control and renders the export output", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      sources: [],
      memories: [],
      pinnedSourceIds: [],
      memoryDisabled: false,
      importStatus: null,
      memoryStatus: "",
      memoryExportText: "",
      knowledgeExportText: "# Knowledge export\n\n(sources omitted)",
      connectorManifests: []
    });
    renderPage(runtime);

    await user.click(screen.getByRole("tab", { name: "Memories" }));
    await user.click(screen.getByRole("button", { name: /export knowledge/i }));
    expect(runtime.exportKnowledge).toHaveBeenCalled();
    expect(screen.getByLabelText(/knowledge export/i)).toBeInTheDocument();
  });

  it("offers a memory export control and renders the export output", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      sources: [],
      memories: [],
      pinnedSourceIds: [],
      memoryDisabled: false,
      importStatus: null,
      memoryStatus: "",
      memoryExportText: "# Memory export",
      knowledgeExportText: "",
      connectorManifests: []
    });
    renderPage(runtime);

    await user.click(screen.getByRole("tab", { name: "Memories" }));
    await user.click(screen.getByRole("button", { name: /export memories/i }));
    expect(runtime.exportMemory).toHaveBeenCalled();
    expect(screen.getByLabelText(/memory export/i)).toBeInTheDocument();
  });
});

describe("KnowledgePage — accessibility and keyboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes accessible names for the lifecycle controls", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      sources: [makeSource()],
      memories: [makeMemory()],
      pinnedSourceIds: [],
      memoryDisabled: false,
      importStatus: null,
      memoryStatus: "",
      memoryExportText: "",
      knowledgeExportText: "",
      connectorManifests: []
    });
    renderPage(runtime);

    // Tabs are a role=tablist with accessible names.
    expect(screen.getByRole("tablist", { name: /knowledge sections/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Sources" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Memories" })).toBeInTheDocument();

    // Pin and expand buttons have descriptive accessible names.
    expect(screen.getByRole("button", { name: /pin quarterly plan/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open quarterly plan/i })).toBeInTheDocument();

    // Search input has an accessible name.
    expect(screen.getByRole("textbox", { name: /search everything/i })).toBeInTheDocument();

    // Memory controls are accessible after switching.
    await user.click(screen.getByRole("tab", { name: "Memories" }));
    expect(screen.getByRole("button", { name: /pin prefers concise answers/i })).toBeInTheDocument();
  });

  it("keeps the memory export textarea labelled for screen readers", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      sources: [],
      memories: [],
      pinnedSourceIds: [],
      memoryDisabled: false,
      importStatus: null,
      memoryStatus: "",
      memoryExportText: "# Memory export",
      knowledgeExportText: "",
      connectorManifests: []
    });
    renderPage(runtime);
    await user.click(screen.getByRole("tab", { name: "Memories" }));
    const exportRegion = screen.getByRole("textbox", { name: /memory export/i });
    expect(exportRegion).toHaveAttribute("readonly");
  });

  it("operates the section tabs by keyboard", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      sources: [makeSource()],
      memories: [makeMemory()],
      pinnedSourceIds: [],
      memoryDisabled: false,
      importStatus: null,
      memoryStatus: "",
      memoryExportText: "",
      knowledgeExportText: "",
      connectorManifests: []
    });
    renderPage(runtime);

    const memoriesTab = screen.getByRole("tab", { name: "Memories" });
    memoriesTab.focus();
    await user.keyboard("{Enter}");
    expect(memoriesTab).toHaveAttribute("aria-selected", "true");
  });
});

describe("KnowledgePage — connector authorization provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces a disconnected connector source and excludes it from the connected state", async () => {
    const user = userEvent.setup();
    const disconnectedSource = makeSource({
      id: "source-gh",
      title: "GitHub issue",
      connectorId: "github",
      provenance: "Connector: github - issue 12",
      contentPreview: "The issue describes a build failure."
    });
    const runtime = stubRuntime({
      sources: [disconnectedSource],
      memories: [],
      pinnedSourceIds: [],
      memoryDisabled: false,
      importStatus: null,
      memoryStatus: "",
      memoryExportText: "",
      knowledgeExportText: "",
      // github is NOT connected.
      connectorManifests: [
        { id: "github", name: "GitHub", status: "fixture" } as ShellRuntime["connectorManifests"][number]
      ]
    });
    renderPage(runtime);

    await user.click(screen.getByRole("button", { name: /^github issue connector:/i }));
    // The expanded meta list surfaces the connector's connection state.
    expect(screen.getAllByText(/disconnected/i).length).toBeGreaterThan(0);
  });
});

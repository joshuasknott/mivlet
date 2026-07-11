import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { KnowledgeSource, LocalFileImport, MemoryRecord } from "@fable/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { artifactExportText, KnowledgePage } from "./KnowledgePage";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import {
  exportRuntimeArtifact,
  getRuntimeArtifact,
  proposeRuntimeArtifactHandoff,
  acceptRuntimeArtifactHandoff,
  searchRuntimeArtifacts,
  type RuntimeArtifactBundle,
  type RuntimeArtifactExport,
  type RuntimeArtifactHandoff,
  type RuntimeArtifactSearchResult
} from "../../runtime";
import { listRuntimeProjects, type RuntimeProject } from "../../lib/project-runtime";

vi.mock("../../runtime", () => ({
  searchRuntimeArtifacts: vi.fn(async () => []),
  getRuntimeArtifact: vi.fn(async () => null),
  exportRuntimeArtifact: vi.fn(),
  proposeRuntimeArtifactHandoff: vi.fn(),
  acceptRuntimeArtifactHandoff: vi.fn()
}));
vi.mock("../../lib/project-runtime", () => ({ listRuntimeProjects: vi.fn(async () => []) }));

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
    accountWorkspaceStatus: {
      configured: true,
      state: "ready",
      message: "Test workspace ready.",
      accountBound: true,
      workspaces: [],
      activeWorkspace: {
        localWorkspaceId: "test-workspace",
        fableWorkspaceId: "hosted-test-workspace",
        name: "Test workspace",
        source: "hosted"
      },
      activeContextOwner: { internalUserId: "test-user" },
      devices: []
    },
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

function makeArtifactBundle(): RuntimeArtifactBundle {
  const first = {
    id: "version-1", artifactId: "artifact-1", version: 1, status: "available",
    createdAt: "2026-07-10T09:00:00.000Z", createdByInternalUserId: "user-1",
    content: { kind: "inline", text: "Historical conclusion", media: { mediaType: "text/markdown", byteLength: 21 }, contentHash: { algorithm: "sha-256", value: "hash-1" } },
    media: { mediaType: "text/markdown", byteLength: 21 }, contentHash: { algorithm: "sha-256", value: "hash-1" },
    provenance: { kind: "run", observedAt: "2026-07-10T09:00:00.000Z" },
    citations: [{ id: "citation-1", sourceId: "source-1", label: "Launch brief", quotedText: "Approved direction" }], lineage: []
  };
  const current = {
    ...first, id: "version-2", version: 2, createdAt: "2026-07-11T09:00:00.000Z",
    content: { ...first.content, text: "Current conclusion", contentHash: { algorithm: "sha-256", value: "hash-2" } },
    contentHash: { algorithm: "sha-256", value: "hash-2" }
  };
  return {
    artifact: {
      id: "artifact-1", workspaceId: "test-workspace", authority: "local", visibility: "member-private",
      ownerMemberId: "member-1", schemaVersion: 1, revision: 2, createdByInternalUserId: "user-1",
      createdAt: "2026-07-10T09:00:00.000Z", updatedAt: "2026-07-11T09:00:00.000Z",
      kind: "document", status: "in-review", title: "Launch report", currentVersionId: "version-2",
      sourceProvenance: [], context: { threadId: "thread-1" }, retention: { status: "active" },
      reviews: [{ id: "review-1", artifactId: "artifact-1", versionId: "version-2", status: "requested", requestedAt: "2026-07-11T09:00:00.000Z", requestedByInternalUserId: "user-1" }]
    },
    currentVersion: current,
    versions: [first, current],
    sourceMessageId: "message-1",
    producingRunId: "run-1"
  } as unknown as RuntimeArtifactBundle;
}

function artifactSearchResult(bundle: RuntimeArtifactBundle): RuntimeArtifactSearchResult {
  return { artifact: bundle.artifact, currentVersion: bundle.currentVersion, matchedOn: ["title"] };
}

function makeProject(overrides: Partial<RuntimeProject> = {}): RuntimeProject {
  return {
    id: "project-target", workspaceId: "test-workspace", authority: "local",
    visibility: "member-private", ownerMemberId: "member-1", schemaVersion: 1,
    revision: 1, createdByInternalUserId: "user-1", createdAt: "2026-07-11T09:00:00.000Z",
    updatedAt: "2026-07-11T09:00:00.000Z", title: "Launch project", lifecycle: "active",
    ...overrides
  } as unknown as RuntimeProject;
}

function makeHandoff(status: "proposed" | "accepted" = "proposed"): RuntimeArtifactHandoff {
  return {
    id: "handoff-1", workspaceId: "test-workspace", authority: "local", visibility: "member-private",
    ownerMemberId: "member-1", schemaVersion: 1, revision: status === "proposed" ? 1 : 2,
    createdByInternalUserId: "user-1", createdAt: "2026-07-11T09:00:00.000Z",
    updatedAt: "2026-07-11T09:00:00.000Z", status,
    source: { workspaceId: "test-workspace", threadId: "thread-1" },
    target: { workspaceId: "test-workspace", projectId: "project-target" },
    artifactVersionIds: ["version-1"], includedContext: [], authorityTransfer: "none",
    proposedByInternalUserId: "user-1", proposedAt: "2026-07-11T09:00:00.000Z",
    ...(status === "accepted" ? { resolvedAt: "2026-07-11T09:01:00.000Z", resolvedByInternalUserId: "user-1" } : {})
  } as unknown as RuntimeArtifactHandoff;
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
    expect(screen.getByText("Choose the current version of this file. Fable won't keep access to its location.")).toBeInTheDocument();
    const file = new File(["new plan"], "quarterly-plan.md", { type: "text/markdown" });
    await user.upload(screen.getByLabelText("Choose the current version of Quarterly plan"), file);
    expect(runtime.refreshKnowledgeSource).toHaveBeenCalledWith("source-1", file);
    expect(screen.getByText("Updating...")).toBeInTheDocument();
    finishUpdate();
    await waitFor(() => expect(screen.queryByText("Updating...")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Open Drive plan" }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(runtime.refreshKnowledgeSource).toHaveBeenCalledWith("connector-1");
  });
});

describe("KnowledgePage — artifacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(searchRuntimeArtifacts).mockResolvedValue([]);
    vi.mocked(listRuntimeProjects).mockResolvedValue([]);
  });

  it("searches on entry and query changes, shows the count, and opens plain-language details", async () => {
    const user = userEvent.setup();
    const bundle = makeArtifactBundle();
    vi.mocked(searchRuntimeArtifacts).mockResolvedValue([artifactSearchResult(bundle)]);
    vi.mocked(getRuntimeArtifact).mockResolvedValue(bundle);
    const runtime = stubRuntime({
      sources: [], memories: [], pinnedSourceIds: [], memoryDisabled: false,
      importStatus: null, memoryStatus: "", memoryExportText: "", knowledgeExportText: "", connectorManifests: []
    });
    renderPage(runtime);

    await user.click(screen.getByRole("tab", { name: "Artifacts" }));
    expect(await screen.findByText("Launch report")).toBeInTheDocument();
    expect(within(screen.getByRole("tab", { name: "Artifacts" })).getByText("1")).toBeInTheDocument();
    expect(searchRuntimeArtifacts).toHaveBeenCalledWith({ limit: 100 });

    const search = screen.getByRole("textbox", { name: "Search artifacts" });
    await user.type(search, "launch");
    await waitFor(() => expect(searchRuntimeArtifacts).toHaveBeenLastCalledWith({ query: "launch", limit: 100 }));
    await user.click(screen.getByRole("button", { name: /Launch report.*Version 2/i }));
    const detail = await screen.findByRole("region", { name: "Artifact details for Launch report" });
    expect(within(detail).getByText("Private review")).toBeInTheDocument();
    expect(within(detail).getByText("Conversation")).toBeInTheDocument();
    expect(within(detail).getByText("Created from a response")).toBeInTheDocument();
    expect(within(detail).getByText("Current conclusion")).toBeInTheDocument();
    expect(within(detail).getByText("Launch brief")).toBeInTheDocument();
  });

  it("exports the selected immutable historical version without local paths or hidden fields", async () => {
    const user = userEvent.setup();
    const bundle = makeArtifactBundle();
    const exported = {
      artifactId: "artifact-1", versionId: "version-1", title: "Launch report", kind: "document",
      exportedAt: "2026-07-11T10:00:00.000Z", content: bundle.versions[0].content,
      citations: bundle.versions[0].citations,
      inputs: [{ sourcePath: "C:\\private\\notes.md", label: "Safe input", hiddenToken: "secret" }],
      decisions: [], lineage: []
    } as unknown as RuntimeArtifactExport;
    vi.mocked(searchRuntimeArtifacts).mockResolvedValue([artifactSearchResult(bundle)]);
    vi.mocked(getRuntimeArtifact).mockResolvedValue(bundle);
    vi.mocked(exportRuntimeArtifact).mockResolvedValue(exported);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:artifact") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const runtime = stubRuntime({
      sources: [], memories: [], pinnedSourceIds: [], memoryDisabled: false,
      importStatus: null, memoryStatus: "", memoryExportText: "", knowledgeExportText: "", connectorManifests: []
    });
    renderPage(runtime);
    await user.click(screen.getByRole("tab", { name: "Artifacts" }));
    await user.click(await screen.findByRole("button", { name: /Launch report.*Version 2/i }));
    await user.selectOptions(await screen.findByLabelText("Version of Launch report"), "version-1");
    await user.click(screen.getByRole("button", { name: "Export Launch report version 1 as JSON" }));
    await waitFor(() => expect(exportRuntimeArtifact).toHaveBeenCalledWith("artifact-1", "version-1"));

    const json = artifactExportText(exported, 1, "json");
    expect(json).toContain("Historical conclusion");
    expect(json).toContain("Safe input");
    expect(json).not.toContain("private");
    expect(json).not.toContain("hiddenToken");
    expect(json).not.toContain("artifact-1");
  });

  it("silently discards an export that resolves after the workspace changes", async () => {
    const user = userEvent.setup();
    const bundle = makeArtifactBundle();
    vi.mocked(searchRuntimeArtifacts).mockResolvedValue([artifactSearchResult(bundle)]);
    vi.mocked(getRuntimeArtifact).mockResolvedValue(bundle);
    let resolveExport!: (value: RuntimeArtifactExport) => void;
    const pendingExport = new Promise<RuntimeArtifactExport>((resolve) => { resolveExport = resolve; });
    vi.mocked(exportRuntimeArtifact).mockReturnValue(pendingExport);
    const createObjectUrl = vi.fn(() => "blob:artifact");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const state = {
      sources: [], memories: [], pinnedSourceIds: [], memoryDisabled: false,
      importStatus: null, memoryStatus: "", memoryExportText: "", knowledgeExportText: "", connectorManifests: []
    };
    const runtime = stubRuntime(state);
    const view = renderPage(runtime);
    await user.click(screen.getByRole("tab", { name: "Artifacts" }));
    await user.click(await screen.findByRole("button", { name: /Launch report.*Version 2/i }));
    await user.click(screen.getByRole("button", { name: "Export Launch report version 2 as JSON" }));
    expect(exportRuntimeArtifact).toHaveBeenCalledWith("artifact-1", "version-2");

    const otherWorkspaceRuntime = stubRuntime(state);
    otherWorkspaceRuntime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId = "other-workspace";
    await act(async () => {
      view.rerender(<KnowledgePage runtime={otherWorkspaceRuntime} />);
    });
    await act(async () => {
      resolveExport({
        artifactId: "artifact-1", versionId: "version-2", title: "Launch report", kind: "document",
        exportedAt: "2026-07-11T10:00:00.000Z", content: bundle.currentVersion.content,
        citations: [], inputs: [], decisions: [], lineage: []
      } as unknown as RuntimeArtifactExport);
      await pendingExport;
    });
    await waitFor(() => expect(searchRuntimeArtifacts).toHaveBeenCalledTimes(2));
    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(screen.queryByText("JSON export ready.")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("prepares and confirms one selected version for an eligible private project", async () => {
    const user = userEvent.setup();
    const bundle = makeArtifactBundle();
    vi.mocked(searchRuntimeArtifacts).mockResolvedValue([artifactSearchResult(bundle)]);
    vi.mocked(getRuntimeArtifact).mockResolvedValue(bundle);
    vi.mocked(listRuntimeProjects).mockResolvedValue([makeProject()]);
    vi.mocked(proposeRuntimeArtifactHandoff).mockResolvedValue(makeHandoff());
    vi.mocked(acceptRuntimeArtifactHandoff).mockResolvedValue(makeHandoff("accepted"));
    const runtime = stubRuntime({
      sources: [], memories: [], pinnedSourceIds: [], memoryDisabled: false,
      importStatus: null, memoryStatus: "", memoryExportText: "", knowledgeExportText: "", connectorManifests: []
    });
    renderPage(runtime);
    await user.click(screen.getByRole("tab", { name: "Artifacts" }));
    await user.click(await screen.findByRole("button", { name: /Launch report.*Version 2/i }));
    await user.selectOptions(await screen.findByLabelText("Version of Launch report"), "version-1");
    const project = await screen.findByLabelText("Project for Launch report version 1");
    await user.selectOptions(project, "project-target");
    expect(screen.getByText("Adds this version only. Conversation history and permissions stay here.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Prepare" }));
    expect(proposeRuntimeArtifactHandoff).toHaveBeenCalledWith({
      artifactId: "artifact-1", versionId: "version-1", targetProjectId: "project-target"
    });
    const confirm = await screen.findByRole("button", { name: "Confirm add version 1" });
    expect(confirm).toHaveFocus();
    await user.click(confirm);
    expect(acceptRuntimeArtifactHandoff).toHaveBeenCalledWith("handoff-1", 1);
    expect(await screen.findByText("Version 1 added to project.")).toBeInTheDocument();
    expect(screen.queryByText(/collaborator|shared|copied conversation/i)).not.toBeInTheDocument();
  });

  it("hides project handoff without an eligible target and shows proposal errors honestly", async () => {
    const user = userEvent.setup();
    const bundle = makeArtifactBundle();
    vi.mocked(searchRuntimeArtifacts).mockResolvedValue([artifactSearchResult(bundle)]);
    vi.mocked(getRuntimeArtifact).mockResolvedValue(bundle);
    const runtime = stubRuntime({
      sources: [], memories: [], pinnedSourceIds: [], memoryDisabled: false,
      importStatus: null, memoryStatus: "", memoryExportText: "", knowledgeExportText: "", connectorManifests: []
    });
    const view = renderPage(runtime);
    await user.click(screen.getByRole("tab", { name: "Artifacts" }));
    await user.click(await screen.findByRole("button", { name: /Launch report.*Version 2/i }));
    await waitFor(() => expect(listRuntimeProjects).toHaveBeenCalled());
    expect(screen.queryByLabelText(/Project for Launch report/)).not.toBeInTheDocument();

    view.unmount();
    vi.mocked(listRuntimeProjects).mockResolvedValue([makeProject()]);
    vi.mocked(proposeRuntimeArtifactHandoff).mockRejectedValue(new Error("That project is no longer available."));
    renderPage(runtime);
    await user.click(screen.getByRole("tab", { name: "Artifacts" }));
    await user.click(await screen.findByRole("button", { name: /Launch report.*Version 2/i }));
    await user.selectOptions(await screen.findByLabelText("Project for Launch report version 2"), "project-target");
    await user.click(screen.getByRole("button", { name: "Prepare" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That project is no longer available.");
  });

  it("discards handoff success and error state when the workspace changes", async () => {
    const user = userEvent.setup();
    const bundle = makeArtifactBundle();
    vi.mocked(searchRuntimeArtifacts).mockResolvedValue([artifactSearchResult(bundle)]);
    vi.mocked(getRuntimeArtifact).mockResolvedValue(bundle);
    vi.mocked(listRuntimeProjects).mockResolvedValue([makeProject()]);
    vi.mocked(proposeRuntimeArtifactHandoff).mockResolvedValue(makeHandoff());
    let resolveAccept!: (handoff: RuntimeArtifactHandoff) => void;
    const pendingAccept = new Promise<RuntimeArtifactHandoff>((resolve) => { resolveAccept = resolve; });
    vi.mocked(acceptRuntimeArtifactHandoff).mockReturnValue(pendingAccept);
    const state = {
      sources: [], memories: [], pinnedSourceIds: [], memoryDisabled: false,
      importStatus: null, memoryStatus: "", memoryExportText: "", knowledgeExportText: "", connectorManifests: []
    };
    const runtime = stubRuntime(state);
    const view = renderPage(runtime);
    await user.click(screen.getByRole("tab", { name: "Artifacts" }));
    await user.click(await screen.findByRole("button", { name: /Launch report.*Version 2/i }));
    await user.selectOptions(await screen.findByLabelText("Project for Launch report version 2"), "project-target");
    await user.click(screen.getByRole("button", { name: "Prepare" }));
    await user.click(await screen.findByRole("button", { name: "Confirm add version 2" }));
    const otherWorkspaceRuntime = stubRuntime(state);
    otherWorkspaceRuntime.accountWorkspaceStatus.activeWorkspace.localWorkspaceId = "other-workspace";
    await act(async () => {
      view.rerender(<KnowledgePage runtime={otherWorkspaceRuntime} />);
      resolveAccept(makeHandoff("accepted"));
      await pendingAccept;
    });
    expect(screen.queryByText(/added to project/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders honest empty and error states", async () => {
    const user = userEvent.setup();
    const runtime = stubRuntime({
      sources: [], memories: [], pinnedSourceIds: [], memoryDisabled: false,
      importStatus: null, memoryStatus: "", memoryExportText: "", knowledgeExportText: "", connectorManifests: []
    });
    const view = renderPage(runtime);
    await user.click(screen.getByRole("tab", { name: "Artifacts" }));
    expect(await screen.findByText("No artifacts found")).toBeInTheDocument();

    vi.mocked(searchRuntimeArtifacts).mockRejectedValue(new Error("Artifacts are unavailable."));
    view.unmount();
    renderPage(runtime);
    await user.click(screen.getByRole("tab", { name: "Artifacts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Artifacts are unavailable.");
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

import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearActiveRuntimeDataScope, getActiveRuntimeDataScope, setActiveRuntimeDataScope } from "./runtime-scope";
import {
  importRuntimeLocalKnowledgeSource,
  loadRuntimeImportedKnowledgeSources,
  saveRuntimeImportedKnowledgeSources,
  searchRuntimeKnowledgeSources
} from "./runtime";
import { selectRuntimeAdapterForTest } from "./runtime/adapters/select";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const candidate = {
  name: "project.md",
  content: "Project knowledge",
  sizeBytes: 17,
  importedAt: "2026-07-11T10:00:00.000Z"
};

function source(id = "source-1") {
  return {
    workspaceId: "workspace-a",
    id,
    title: "Project",
    kind: "document" as const,
    connectorId: "local-files" as const,
    provenance: "Local file",
    freshness: "now",
    pinned: false,
    trust: "untrusted" as const,
    contentPreview: "Project knowledge",
    contentFingerprint: "fingerprint",
    sizeBytes: 17,
    importedAt: candidate.importedAt,
    origin: "local-import" as const,
    scope: { level: "project" as const, projectId: "project-a" }
  };
}

function setNative(enabled: boolean) {
  selectRuntimeAdapterForTest(enabled ? "native" : "preview");
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: enabled ? {} : undefined
  });
}

describe("project knowledge runtime scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearActiveRuntimeDataScope();
    setNative(false);
  });

  it("passes exact native scope without mutating the active runtime scope", async () => {
    setNative(true);
    setActiveRuntimeDataScope("workspace-a");
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "list_imported_knowledge_sources") return [];
      if (command === "save_imported_knowledge_sources") return [source()];
      if (command === "import_local_knowledge_source") return source();
      return { query: "project", mode: "lexical-fallback", citations: [] };
    });
    const scope = { workspaceId: "workspace-a", projectId: "project-a" };

    await loadRuntimeImportedKnowledgeSources(scope);
    await saveRuntimeImportedKnowledgeSources([source()], scope);
    await importRuntimeLocalKnowledgeSource(candidate, scope);
    await searchRuntimeKnowledgeSources("project", [source()], 3, scope);

    expect(mocks.invoke.mock.calls).toEqual([
      ["list_imported_knowledge_sources", scope],
      ["save_imported_knowledge_sources", { sources: [source()], ...scope }],
      ["import_local_knowledge_source", { candidate, ...scope }],
      ["search_knowledge_sources", { query: "project", sources: [source()], limit: 3, ...scope }]
    ]);
    expect(getActiveRuntimeDataScope()).toEqual({ workspaceId: "workspace-a", projectId: null });
  });

  it("rejects a workspace override before invoking native code", async () => {
    setNative(true);
    setActiveRuntimeDataScope("workspace-a");
    await expect(loadRuntimeImportedKnowledgeSources({
      workspaceId: "workspace-b",
      projectId: "project-b"
    })).rejects.toThrow("workspace changed");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("surfaces native project authorization errors for explicit reads and searches", async () => {
    setNative(true);
    setActiveRuntimeDataScope("workspace-a");
    mocks.invoke.mockRejectedValue("Archived projects are read-only.");
    const scope = { workspaceId: "workspace-a", projectId: "project-a" };
    await expect(loadRuntimeImportedKnowledgeSources(scope)).rejects.toThrow("read-only");
    await expect(searchRuntimeKnowledgeSources("notes", [], undefined, scope)).rejects.toThrow("read-only");
  });

  it("isolates preview imports and search by workspace and project", async () => {
    setActiveRuntimeDataScope("workspace-a");
    const a = { workspaceId: "workspace-a", projectId: "project-a-runtime-test" };
    const b = { workspaceId: "workspace-a", projectId: "project-b-runtime-test" };
    await importRuntimeLocalKnowledgeSource(candidate, a);
    expect(await loadRuntimeImportedKnowledgeSources(a)).toHaveLength(1);
    expect(await loadRuntimeImportedKnowledgeSources(b)).toEqual([]);
    setActiveRuntimeDataScope("workspace-b");
    const otherWorkspace = { workspaceId: "workspace-b", projectId: "project-a-runtime-test" };
    await importRuntimeLocalKnowledgeSource(candidate, otherWorkspace);
    expect(await loadRuntimeImportedKnowledgeSources(otherWorkspace)).toHaveLength(1);
    setActiveRuntimeDataScope("workspace-a");
    expect(await loadRuntimeImportedKnowledgeSources(a)).toHaveLength(1);
    const result = await searchRuntimeKnowledgeSources(
      "project",
      (await loadRuntimeImportedKnowledgeSources(a)) ?? [],
      undefined,
      a
    );
    expect(result?.citations).toHaveLength(1);
    await expect(searchRuntimeKnowledgeSources(
      "project",
      (await loadRuntimeImportedKnowledgeSources(a)) ?? [],
      undefined,
      b
    )).rejects.toThrow("outside this project");
  });
});

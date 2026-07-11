import type { PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectKnowledge } from "./useProjectKnowledge";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  importSource: vi.fn(),
  refreshSource: vi.fn(),
  buildRefresh: vi.fn(),
  search: vi.fn(),
  getProject: vi.fn()
}));

vi.mock("../runtime", () => ({
  loadRuntimeImportedKnowledgeSources: mocks.load,
  saveRuntimeImportedKnowledgeSources: mocks.save,
  importRuntimeLocalKnowledgeSource: mocks.importSource,
  refreshRuntimeLocalKnowledgeSource: mocks.refreshSource,
  searchRuntimeKnowledgeSources: mocks.search
}));
vi.mock("../lib/local-knowledge-refresh", () => ({ buildLocalKnowledgeRefreshRequest: mocks.buildRefresh }));
vi.mock("../lib/project-runtime", () => ({ getRuntimeProject: mocks.getProject }));

const imported = {
  workspaceId: "workspace-a",
  id: "source-1",
  title: "Notes",
  kind: "document",
  connectorId: "local-files",
  provenance: "Local file",
  freshness: "now",
  pinned: false,
  trust: "untrusted",
  contentPreview: "Useful notes",
  contentFingerprint: "fingerprint",
  sizeBytes: 12,
  importedAt: "2026-07-11T10:00:00.000Z",
  origin: "local-import",
  scope: { level: "project", projectId: "project-a" }
};

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useProjectKnowledge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.load.mockResolvedValue([]);
    mocks.importSource.mockResolvedValue(imported);
    mocks.save.mockImplementation(async (sources) => sources);
    mocks.buildRefresh.mockImplementation(async (source, file: File) => ({ sourceId: source.id, candidate: { name: file.name, content: "selected content" } }));
    mocks.search.mockResolvedValue({ query: "notes", mode: "lexical-fallback", citations: [] });
    mocks.getProject.mockResolvedValue({ id: "project-a", lifecycle: "active" });
  });

  it("imports a supported file into the exact scope and refreshes", async () => {
    mocks.load.mockResolvedValueOnce([]).mockResolvedValueOnce([imported]);
    const { result } = renderHook(() => useProjectKnowledge({
      workspaceId: "workspace-a",
      projectId: "project-a",
      enabled: true
    }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const file = new File(["Useful notes"], "notes.md", { type: "text/markdown" });
    await act(async () => { await result.current.importFile(file); });
    await waitFor(() => expect(result.current.sources).toHaveLength(1));

    expect(mocks.importSource).toHaveBeenCalledWith(
      expect.objectContaining({ name: "notes.md", content: "Useful notes", sizeBytes: 12 }),
      { workspaceId: "workspace-a", projectId: "project-a" }
    );
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });

  it("allows archived reads but surfaces a write error", async () => {
    mocks.load.mockResolvedValue([imported]);
    mocks.getProject.mockResolvedValue({ id: "project-a", lifecycle: "archived" });
    const { result } = renderHook(() => useProjectKnowledge({
      workspaceId: "workspace-a",
      projectId: "project-a",
      enabled: true
    }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.sources).toHaveLength(1));
    let failure: unknown;
    await act(async () => {
      try {
        await result.current.importFile(new File(["New"], "new.md"));
      } catch (error) {
        failure = error;
      }
    });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/read-only/i);
    await waitFor(() => expect(result.current.error).toMatch(/read-only/i));
    expect(mocks.importSource).not.toHaveBeenCalled();
  });

  it("disables and re-enables a source while excluding it from search", async () => {
    mocks.load.mockResolvedValue([imported]);
    // Native live reads may omit disabled rows; the exact-scope cache must
    // retain lifecycle state so the user can re-enable it.
    mocks.save.mockResolvedValueOnce([]);
    const { result } = renderHook(() => useProjectKnowledge({ workspaceId: "workspace-a", projectId: "project-a", enabled: true }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.sources).toHaveLength(1));
    await act(async () => { await result.current.toggleDisabled("source-1"); });
    await waitFor(() => expect(result.current.sources[0].disabled).toBe(true));
    expect(result.current.liveSources).toEqual([]);
    await act(async () => { await result.current.search("notes"); });
    expect(mocks.search).toHaveBeenLastCalledWith("notes", [], undefined, { workspaceId: "workspace-a", projectId: "project-a" });
    await act(async () => { await result.current.toggleDisabled("source-1"); });
    await waitFor(() => expect(result.current.sources[0].disabled).toBe(false));
    expect(result.current.liveSources).toHaveLength(1);
  });

  it("persists a delete tombstone, hides the row, and keeps it in the full save", async () => {
    mocks.load.mockResolvedValue([imported]);
    const { result } = renderHook(() => useProjectKnowledge({ workspaceId: "workspace-a", projectId: "project-a", enabled: true }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.sources).toHaveLength(1));
    await act(async () => { await result.current.remove("source-1"); });
    await waitFor(() => expect(result.current.sources).toEqual([]));
    expect(result.current.liveSources).toEqual([]);
    expect(mocks.save).toHaveBeenCalledWith([
      expect.objectContaining({ id: "source-1", disabled: true, pinned: false, deletedAt: expect.any(String) })
    ], { workspaceId: "workspace-a", projectId: "project-a" });
  });

  it("rolls an optimistic lifecycle mutation back when native persistence fails", async () => {
    mocks.load.mockResolvedValue([imported]);
    mocks.save.mockRejectedValueOnce(new Error("native save failed"));
    const { result } = renderHook(() => useProjectKnowledge({ workspaceId: "workspace-a", projectId: "project-a", enabled: true }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.sources).toHaveLength(1));
    await act(async () => { await expect(result.current.toggleDisabled("source-1")).rejects.toThrow("native save failed"); });
    expect(result.current.sources[0].disabled).toBeFalsy();
    expect(result.current.error).toBe("native save failed");
  });

  it("keeps exact project query caches isolated", async () => {
    mocks.load.mockImplementation((scope: { workspaceId: string; projectId: string }) => Promise.resolve([
      { ...imported, workspaceId: scope.workspaceId, id: `source-${scope.projectId}`, scope: { level: "project", projectId: scope.projectId } }
    ]));
    const sharedWrapper = wrapper();
    const a = renderHook(() => useProjectKnowledge({ workspaceId: "workspace-a", projectId: "project-a", enabled: true }), { wrapper: sharedWrapper });
    const b = renderHook(() => useProjectKnowledge({ workspaceId: "workspace-a", projectId: "project-b", enabled: true }), { wrapper: sharedWrapper });
    const otherWorkspace = renderHook(() => useProjectKnowledge({ workspaceId: "workspace-b", projectId: "project-a", enabled: true }), { wrapper: sharedWrapper });
    await waitFor(() => expect(a.result.current.sources).toHaveLength(1));
    await waitFor(() => expect(b.result.current.sources).toHaveLength(1));
    await waitFor(() => expect(otherWorkspace.result.current.sources).toHaveLength(1));
    await act(async () => { await a.result.current.toggleDisabled("source-project-a"); });
    await waitFor(() => expect(a.result.current.sources[0].disabled).toBe(true));
    expect(b.result.current.sources[0].disabled).toBeFalsy();
    expect(otherWorkspace.result.current.sources[0].disabled).toBeFalsy();
    expect(mocks.save).toHaveBeenLastCalledWith(expect.any(Array), { workspaceId: "workspace-a", projectId: "project-a" });
  });

  it("rejects lifecycle writes for archived projects", async () => {
    mocks.load.mockResolvedValue([imported]);
    mocks.getProject.mockResolvedValue({ id: "project-a", lifecycle: "archived" });
    const { result } = renderHook(() => useProjectKnowledge({ workspaceId: "workspace-a", projectId: "project-a", enabled: true }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.sources).toHaveLength(1));
    await act(async () => { await expect(result.current.toggleDisabled("source-1")).rejects.toThrow(/read-only/i); });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(result.current.sources[0].disabled).toBeFalsy();
  });

  it("updates only the exact project after native success and searches new content", async () => {
    mocks.load.mockResolvedValue([{ ...imported, pinned: true, disabled: false }]);
    mocks.refreshSource.mockResolvedValue({ outcome: "updated", source: { ...imported, contentPreview: "New launch content", contentFingerprint: "new-fp", freshness: "Updated now", pinned: false, disabled: true } });
    const { result } = renderHook(() => useProjectKnowledge({ workspaceId: "workspace-a", projectId: "project-a", enabled: true }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.sources).toHaveLength(1));
    const file = new File(["New launch content"], "notes.md", { type: "text/markdown" });
    await act(async () => { await result.current.updateFile("source-1", file); });
    expect(mocks.refreshSource).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "source-1" }), { workspaceId: "workspace-a", projectId: "project-a" });
    expect(result.current.sources[0]).toMatchObject({ contentPreview: "New launch content", contentFingerprint: "new-fp", pinned: true, disabled: false });
    expect(result.current.actionStatus).toBe("Updated from notes.md.");
    await act(async () => { await result.current.search("launch"); });
    expect(mocks.search).toHaveBeenLastCalledWith("launch", [expect.objectContaining({ contentPreview: "New launch content" })], undefined, { workspaceId: "workspace-a", projectId: "project-a" });
  });

  it("keeps old project state on unchanged and stale responses", async () => {
    mocks.load.mockResolvedValue([imported]);
    mocks.refreshSource.mockResolvedValueOnce({ outcome: "unchanged", source: imported });
    const { result } = renderHook(() => useProjectKnowledge({ workspaceId: "workspace-a", projectId: "project-a", enabled: true }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.sources).toHaveLength(1));
    const file = new File(["Useful notes"], "notes.md", { type: "text/markdown" });
    await act(async () => { await result.current.updateFile("source-1", file); });
    expect(result.current.actionStatus).toBe("This source is already up to date.");
    mocks.refreshSource.mockRejectedValueOnce(new Error("This source changed elsewhere. Reload Knowledge and try again."));
    await act(async () => { await expect(result.current.updateFile("source-1", file)).rejects.toThrow(/changed elsewhere/i); });
    expect(result.current.sources[0].contentFingerprint).toBe("fingerprint");
    expect(result.current.error).toMatch(/changed elsewhere/i);
  });
});

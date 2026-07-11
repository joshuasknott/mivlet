import type { PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectKnowledge } from "./useProjectKnowledge";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  importSource: vi.fn(),
  search: vi.fn(),
  getProject: vi.fn()
}));

vi.mock("../runtime", () => ({
  loadRuntimeImportedKnowledgeSources: mocks.load,
  importRuntimeLocalKnowledgeSource: mocks.importSource,
  searchRuntimeKnowledgeSources: mocks.search
}));
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
});

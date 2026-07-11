import type { PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { KnowledgeSource, MemoryControlState, MemoryRecord } from "@fable/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectMemory } from "./useProjectMemory";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  exportState: vi.fn(),
  promote: vi.fn()
}));

vi.mock("../runtime", () => ({
  loadRuntimeMemoryState: mocks.load,
  saveRuntimeMemoryState: mocks.save,
  exportRuntimeMemoryState: mocks.exportState,
  promoteRuntimeKnowledgeSourceToMemory: mocks.promote
}));

const record = (overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: "memory-1",
  kind: "imported",
  title: "Launch brief",
  value: "Ship on Friday",
  source: "Approved from local file",
  freshness: "Approved now",
  approved: true,
  pinned: true,
  ...overrides
});

const source: KnowledgeSource = {
  id: "source-1",
  title: "Launch brief",
  kind: "document",
  connectorId: "local-files",
  provenance: "Local file",
  freshness: "Updated today",
  pinned: false,
  contentPreview: "Ship on Friday",
  trust: "untrusted",
  scope: { level: "project", projectId: "project-a" }
};

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useProjectMemory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.load.mockResolvedValue({ disabled: false, records: [] });
    mocks.save.mockImplementation(async (state: MemoryControlState) => state);
    mocks.exportState.mockResolvedValue("# Project memory");
    mocks.promote.mockImplementation(async (request) => ({
      persisted: true,
      record: record(),
      auditEntry: { id: "audit-1", requestId: "request-1", decision: "once", decidedAt: request.decidedAt, note: "Approved" },
      state: { disabled: false, records: [record()] }
    }));
  });

  it("isolates independent project queries and ignores a late response from another project", async () => {
    let releaseA!: (state: MemoryControlState) => void;
    mocks.load.mockImplementation((scope: { projectId: string }) => scope.projectId === "project-a"
      ? new Promise<MemoryControlState>((resolve) => { releaseA = resolve; })
      : Promise.resolve({ disabled: false, records: [record({ id: "memory-b", title: "Project B" })] }));
    const wrapper = createWrapper();
    const a = renderHook(() => useProjectMemory({ workspaceId: "workspace-a", projectId: "project-a", enabled: true }), { wrapper });
    const b = renderHook(() => useProjectMemory({ workspaceId: "workspace-a", projectId: "project-b", enabled: true }), { wrapper });
    await waitFor(() => expect(b.result.current.records[0]?.title).toBe("Project B"));
    act(() => releaseA({ disabled: false, records: [record({ title: "Project A" })] }));
    await waitFor(() => expect(a.result.current.records[0]?.title).toBe("Project A"));
    expect(b.result.current.records[0]?.title).toBe("Project B");
  });

  it("promotes an imported source through the exact project scope", async () => {
    const { result } = renderHook(() => useProjectMemory({ workspaceId: "workspace-a", projectId: "project-a", enabled: true }), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.promote(source); });
    expect(mocks.promote).toHaveBeenCalledWith(
      expect.objectContaining({ source, decision: "once", state: { disabled: false, records: [] } }),
      { workspaceId: "workspace-a", projectId: "project-a" }
    );
    expect(result.current.records).toHaveLength(1);
  });

  it("persists edits, pinning and disabling, then rolls back a failed change", async () => {
    mocks.load.mockResolvedValue({ disabled: false, records: [record()] });
    const { result } = renderHook(() => useProjectMemory({ workspaceId: "workspace-a", projectId: "project-a", enabled: true }), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.records).toHaveLength(1));
    await act(async () => { await result.current.edit("memory-1", { title: "Launch plan", value: "Ship Monday" }); });
    expect(result.current.records[0]).toMatchObject({ title: "Launch plan", value: "Ship Monday" });
    await act(async () => { await result.current.togglePin("memory-1"); });
    expect(result.current.records[0].pinned).toBe(false);
    await act(async () => { await result.current.toggleDisabled("memory-1"); });
    expect(result.current.records[0].disabled).toBe(true);
    expect(result.current.contextRecords).toEqual([]);

    mocks.save.mockRejectedValueOnce(new Error("native save failed"));
    await act(async () => { await expect(result.current.toggleDisabled("memory-1")).rejects.toThrow("native save failed"); });
    expect(result.current.records[0].disabled).toBe(true);
    expect(result.current.error).toBe("native save failed");
  });

  it("hides forgotten records while retaining every tombstone in the saved state", async () => {
    const priorTombstone = record({ id: "memory-old", forgottenAt: "2026-07-10T10:00:00.000Z" });
    mocks.load.mockResolvedValue({ disabled: false, records: [priorTombstone, record()] });
    const { result } = renderHook(() => useProjectMemory({ workspaceId: "workspace-a", projectId: "project-a", enabled: true }), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.records).toHaveLength(1));
    await act(async () => { await result.current.forget("memory-1"); });
    expect(result.current.records).toEqual([]);
    const saved = mocks.save.mock.calls.at(-1)?.[0] as MemoryControlState;
    expect(saved.records).toHaveLength(2);
    expect(saved.records.every((item) => item.forgottenAt)).toBe(true);
  });

  it("exports the full authoritative state within the exact project scope", async () => {
    mocks.load.mockResolvedValue({ disabled: false, records: [record()] });
    const { result } = renderHook(() => useProjectMemory({ workspaceId: "workspace-a", projectId: "project-a", enabled: true }), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.records).toHaveLength(1));
    let exported = "";
    await act(async () => { exported = await result.current.exportText(); });
    expect(exported).toBe("# Project memory");
    expect(mocks.exportState).toHaveBeenCalledWith(
      { disabled: false, records: [expect.objectContaining({ id: "memory-1" })] },
      { workspaceId: "workspace-a", projectId: "project-a" }
    );
  });

  it("refreshes the exact scope before returning live run context", async () => {
    mocks.load
      .mockResolvedValueOnce({ disabled: false, records: [] })
      .mockResolvedValueOnce({
        disabled: false,
        records: [record(), record({ id: "disabled", disabled: true }), record({ id: "forgotten", forgottenAt: "2026-07-11T10:00:00.000Z" })]
      });
    const { result } = renderHook(() => useProjectMemory({ workspaceId: "workspace-a", projectId: "project-a", enabled: true }), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let context: MemoryRecord[] = [];
    await act(async () => { context = await result.current.loadContextRecords(); });
    expect(context.map((item) => item.id)).toEqual(["memory-1"]);
    expect(mocks.load).toHaveBeenLastCalledWith({ workspaceId: "workspace-a", projectId: "project-a" });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearActiveRuntimeDataScope, getActiveRuntimeDataScope, setActiveRuntimeDataScope } from "./runtime-scope";
import {
  exportRuntimeMemoryState,
  loadRuntimeMemoryState,
  promoteRuntimeKnowledgeSourceToMemory,
  saveRuntimeImportedKnowledgeSources,
  saveRuntimeMemoryState
} from "./runtime";
import { selectRuntimeAdapterForTest } from "./runtime/adapters/select";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const scope = { workspaceId: "workspace-a", projectId: "project-a" };
const empty = { disabled: false, records: [] };
const source = {
  workspaceId: "workspace-a",
  id: "source-1",
  title: "Canonical title",
  kind: "document" as const,
  connectorId: "local-files" as const,
  provenance: "Canonical file",
  freshness: "Imported now",
  pinned: false,
  trust: "untrusted" as const,
  contentPreview: "Canonical content",
  contentFingerprint: "fingerprint",
  sizeBytes: 17,
  importedAt: "2026-07-11T10:00:00.000Z",
  origin: "local-import" as const,
  scope: { level: "project" as const, projectId: "project-a" }
};

function setNative(enabled: boolean) {
  selectRuntimeAdapterForTest(enabled ? "native" : "preview");
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: enabled ? {} : undefined
  });
}

describe("project memory runtime scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearActiveRuntimeDataScope();
    setNative(false);
  });

  it("passes exact native scope without mutating the active runtime scope", async () => {
    setNative(true);
    setActiveRuntimeDataScope("workspace-a");
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "export_memory_state") return "{}";
      if (command === "promote_knowledge_source_to_memory") return { persisted: true };
      return empty;
    });
    const request = {
      source,
      decision: "once" as const,
      decidedAt: "2026-07-11T11:00:00.000Z",
      state: empty
    };

    await loadRuntimeMemoryState(scope);
    await saveRuntimeMemoryState(empty, scope);
    await exportRuntimeMemoryState(empty, scope);
    await promoteRuntimeKnowledgeSourceToMemory(request, scope);

    expect(mocks.invoke.mock.calls).toEqual([
      ["list_memory_state", scope],
      ["save_memory_state", { state: empty, ...scope }],
      ["export_memory_state", scope],
      ["promote_knowledge_source_to_memory", { request, ...scope }]
    ]);
    expect(getActiveRuntimeDataScope()).toEqual({ workspaceId: "workspace-a", projectId: null });
  });

  it("rejects workspace mismatch and foreign records before native invocation", async () => {
    setNative(true);
    setActiveRuntimeDataScope("workspace-a");
    await expect(loadRuntimeMemoryState({ workspaceId: "workspace-b", projectId: "project-b" }))
      .rejects.toThrow("workspace changed");
    setNative(false);
    await expect(saveRuntimeMemoryState({
      disabled: false,
      records: [{
        id: "foreign", kind: "fact", title: "Foreign", value: "Foreign", source: "manual",
        freshness: "now", approved: true, pinned: false,
        scope: { level: "project", projectId: "project-b" }
      }]
    }, scope)).rejects.toThrow("cross project");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("isolates preview state and promotes only canonical project knowledge", async () => {
    setActiveRuntimeDataScope("workspace-a");
    const other = { workspaceId: "workspace-a", projectId: "project-b" };
    await saveRuntimeImportedKnowledgeSources([source], scope);
    const response = await promoteRuntimeKnowledgeSourceToMemory({
      source: { ...source, title: "Forged", provenance: "Forged", contentPreview: "Forged" },
      decision: "once",
      decidedAt: "2026-07-11T11:00:00.000Z",
      state: { disabled: false, records: [{
        id: "injected", kind: "fact", title: "Injected", value: "Injected", source: "renderer",
        freshness: "now", approved: true, pinned: false
      }] }
    }, scope);

    expect(response?.record.title).toBe("Canonical title");
    expect(response?.record.value).toBe("Canonical content");
    expect(response?.record.scope).toEqual({ level: "project", projectId: "project-a" });
    expect(response?.record.provenance).toMatchObject({
      sourceId: "source-1", contentFingerprint: "fingerprint", projectId: "project-a"
    });
    expect(response?.state.records.some((record) => record.id === "injected")).toBe(false);
    expect((await loadRuntimeMemoryState(other))?.records).toEqual([]);
    await expect(promoteRuntimeKnowledgeSourceToMemory({
      source: { ...source, id: "missing" }, decision: "once", decidedAt: "now", state: empty
    }, other)).rejects.toThrow("unavailable");
  });

  it("exports only live enabled preview records while retaining provenance", async () => {
    setActiveRuntimeDataScope("workspace-a");
    const state = await saveRuntimeMemoryState({
      disabled: false,
      records: [
        { id: "live", kind: "fact", title: "Live", value: "value", source: "file", freshness: "now", approved: true, pinned: false, provenance: { origin: "source", sourceId: "s", note: "file" } },
        { id: "disabled", kind: "fact", title: "Disabled", value: "value", source: "file", freshness: "now", approved: true, pinned: false, disabled: true },
        { id: "forgotten", kind: "fact", title: "Forgotten", value: "value", source: "file", freshness: "now", approved: true, pinned: false, forgottenAt: "then" }
      ]
    }, scope);
    const exported = JSON.parse((await exportRuntimeMemoryState(state!, scope))!);
    expect(exported.records).toHaveLength(1);
    expect(exported.records[0].provenance).toMatchObject({ sourceId: "s", note: "file" });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearActiveRuntimeDataScope, getActiveRuntimeDataScope, setActiveRuntimeDataScope } from "./runtime-scope";
import {
  importRuntimeLocalKnowledgeSource, loadRuntimeImportedKnowledgeSources,
  refreshRuntimeLocalKnowledgeSource, searchRuntimeKnowledgeSources
} from "./runtime";
import { selectRuntimeAdapterForTest } from "./runtime/adapters/select";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const a = { workspaceId: "workspace-a", projectId: "project-a-refresh" };
const b = { workspaceId: "workspace-a", projectId: "project-b-refresh" };
const old = { name: "notes.md", content: "old notes", sizeBytes: 9, importedAt: "before" };
function setNative(enabled: boolean) {
  selectRuntimeAdapterForTest(enabled ? "native" : "preview");
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: enabled ? {} : undefined });
}

describe("local knowledge refresh runtime", () => {
  beforeEach(() => { vi.clearAllMocks(); clearActiveRuntimeDataScope(); setNative(false); });

  it("passes exact native scope without mutating the active scope", async () => {
    setNative(true); setActiveRuntimeDataScope("workspace-a");
    const request = { sourceId: "s", expectedContentFingerprint: "f", file: { name: "notes.md", content: "new", sizeBytes: 3, selectedAt: "now" } };
    mocks.invoke.mockResolvedValue({ outcome: "updated", source: {} });
    await refreshRuntimeLocalKnowledgeSource(request, a);
    expect(mocks.invoke).toHaveBeenCalledWith("refresh_local_knowledge_source", { request, ...a });
    expect(getActiveRuntimeDataScope()).toEqual({ workspaceId: "workspace-a", projectId: null });
  });

  it("updates only the exact preview scope and search sees the replacement", async () => {
    setActiveRuntimeDataScope("workspace-a");
    const sourceA = await importRuntimeLocalKnowledgeSource(old, a);
    await importRuntimeLocalKnowledgeSource(old, b);
    const request = {
      sourceId: sourceA!.id, expectedContentFingerprint: sourceA!.contentFingerprint,
      file: { name: "notes.md", content: "new searchable phrase", sizeBytes: 21, selectedAt: "now" }
    };
    const response = await refreshRuntimeLocalKnowledgeSource(request, a);
    expect(response?.outcome).toBe("updated");
    expect((await loadRuntimeImportedKnowledgeSources(b))?.[0].contentPreview).toBe("old notes");
    const found = await searchRuntimeKnowledgeSources("searchable", (await loadRuntimeImportedKnowledgeSources(a))!, undefined, a);
    expect(found?.citations[0].sourceId).toBe(sourceA!.id);
  });

  it("leaves canonical preview state untouched on stale CAS and identical content", async () => {
    setActiveRuntimeDataScope("workspace-a");
    const source = await importRuntimeLocalKnowledgeSource(old, a);
    await expect(refreshRuntimeLocalKnowledgeSource({
      sourceId: source!.id, expectedContentFingerprint: "stale",
      file: { name: "notes.md", content: "new", sizeBytes: 3, selectedAt: "now" }
    }, a)).rejects.toThrow("changed elsewhere");
    expect((await loadRuntimeImportedKnowledgeSources(a))?.[0]).toEqual(source);
    const unchanged = await refreshRuntimeLocalKnowledgeSource({
      sourceId: source!.id, expectedContentFingerprint: source!.contentFingerprint,
      file: { name: "notes.md", content: "old notes", sizeBytes: 9, selectedAt: "now" }
    }, a);
    expect(unchanged).toEqual({ outcome: "unchanged", source });
  });
});

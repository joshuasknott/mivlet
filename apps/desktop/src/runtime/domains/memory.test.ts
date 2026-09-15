import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveRuntimeDataScope,
  getActiveRuntimeDataScope,
  setActiveRuntimeDataScope,
} from "../../runtime-scope";
import {
  importRuntimeLocalKnowledgeSource,
  loadRuntimeImportedKnowledgeSources,
  refreshRuntimeLocalKnowledgeSource,
  searchRuntimeKnowledgeSources,
} from "./memory";
import { selectRuntimeAdapterForTest } from "../adapters/select";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

function setNative(enabled: boolean) {
  selectRuntimeAdapterForTest(enabled ? "native" : "preview");
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: enabled ? {} : undefined,
  });
}

describe("workspace knowledge runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearActiveRuntimeDataScope();
    setNative(false);
  });

  it("does not simulate native knowledge persistence in preview", async () => {
    setActiveRuntimeDataScope("workspace-a");
    const candidate = {
      name: "notes.md",
      content: "notes",
      sizeBytes: 5,
      importedAt: "2026-08-28T09:00:00.000Z",
    };
    await expect(loadRuntimeImportedKnowledgeSources()).resolves.toBeNull();
    await expect(
      importRuntimeLocalKnowledgeSource(candidate),
    ).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("uses the selected workspace for native refresh and search", async () => {
    setNative(true);
    setActiveRuntimeDataScope("workspace-a");
    const request = {
      sourceId: "source-1",
      expectedContentFingerprint: "fingerprint-1",
      file: {
        name: "notes.md",
        content: "new notes",
        sizeBytes: 9,
        selectedAt: "2026-08-28T09:00:00.000Z",
      },
    };
    mocks.invoke
      .mockResolvedValueOnce({ outcome: "updated", source: {} })
      .mockResolvedValueOnce({ citations: [], degraded: false });

    await refreshRuntimeLocalKnowledgeSource(request);
    await searchRuntimeKnowledgeSources("notes", []);

    expect(mocks.invoke.mock.calls).toEqual([
      [
        "refresh_local_knowledge_source",
        {
          request,
          workspaceId: "workspace-a",
        },
      ],
      [
        "search_knowledge_sources",
        {
          query: "notes",
          sources: [],
          limit: undefined,
          workspaceId: "workspace-a",
        },
      ],
    ]);
    expect(getActiveRuntimeDataScope()).toEqual({ workspaceId: "workspace-a" });
  });
});

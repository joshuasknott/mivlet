import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteRuntimeConnectorKnowledgeSource,
  importRuntimeConnectorItem,
  listRuntimeConnectorAccounts,
  listRuntimeConnectorKnowledgeSources,
  searchRuntimeConnector,
  setRuntimeConnectorKnowledgeSourceDisabled,
  switchRuntimeConnectorAccount
} from "./runtime";
import { setActiveRuntimeDataScope } from "./runtime-scope";
import { selectRuntimeAdapterForTest } from "./runtime/adapters/select";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

function setNative(enabled: boolean) {
  selectRuntimeAdapterForTest(enabled ? "native" : "preview");
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: enabled ? {} : undefined
  });
}

describe("connector Connection runtime boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setNative(false);
    setActiveRuntimeDataScope("default");
  });

  it("does not project or select Connections outside Tauri", async () => {
    await expect(listRuntimeConnectorAccounts("gmail")).resolves.toBeNull();
    await expect(switchRuntimeConnectorAccount("gmail", "connection-safe")).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("selects only the opaque Connection id inside the active workspace", async () => {
    setNative(true);
    mocks.invoke
      .mockResolvedValueOnce([{ connectionId: "connection-safe", active: true }])
      .mockResolvedValueOnce({ id: "gmail", status: "connected" });

    await listRuntimeConnectorAccounts("gmail");
    await switchRuntimeConnectorAccount("gmail", "connection-safe");

    expect(mocks.invoke.mock.calls).toEqual([
      ["list_connector_accounts", { connectorId: "gmail", workspaceId: "default" }],
      ["switch_connector_account", {
        connectorId: "gmail",
        connectionId: "connection-safe",
        workspaceId: "default"
      }]
    ]);
  });

  it("scopes durable connector knowledge lifecycle calls to the active workspace", async () => {
    setNative(true);
    mocks.invoke
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ id: "source-1", disabled: true })
      .mockResolvedValueOnce({ id: "source-1", deletedAt: "now" });

    await listRuntimeConnectorKnowledgeSources();
    await setRuntimeConnectorKnowledgeSourceDisabled("source-1", true);
    await deleteRuntimeConnectorKnowledgeSource("source-1");

    expect(mocks.invoke.mock.calls).toEqual([
      ["list_connector_knowledge_sources", {
        workspaceId: "default",
        projectId: null
      }],
      ["set_connector_knowledge_source_disabled", {
        sourceId: "source-1",
        disabled: true,
        workspaceId: "default",
        projectId: null
      }],
      ["delete_connector_knowledge_source", {
        sourceId: "source-1",
        workspaceId: "default",
        projectId: null
      }]
    ]);
  });

  it("passes an exact Project and Connection through search, import, and lifecycle calls", async () => {
    setNative(true);
    mocks.invoke
      .mockResolvedValueOnce({ connectorId: "github", query: "release", items: [] })
      .mockResolvedValueOnce({ source: { id: "source-1" }, imported: true })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ id: "source-1", disabled: true })
      .mockResolvedValueOnce({ id: "source-1", deletedAt: "now" });
    const scope = { workspaceId: "default", projectId: "project-1" };
    const item = {
      id: "issue-42",
      connectorId: "github" as const,
      connectionId: "connection-1",
      title: "Issue 42",
      kind: "issue" as const,
      summary: "Release blocker",
      provenance: "GitHub issue",
      freshness: "now",
      trust: "untrusted" as const,
      providerMetadata: {}
    };

    await searchRuntimeConnector(
      { connectorId: "github", query: "release", limit: 20 },
      scope,
      "connection-1"
    );
    await importRuntimeConnectorItem({
      connectorId: "github",
      item,
      importedAt: "2026-07-25T10:00:00.000Z"
    }, scope, "connection-1");
    await listRuntimeConnectorKnowledgeSources(scope);
    await setRuntimeConnectorKnowledgeSourceDisabled("source-1", true, scope);
    await deleteRuntimeConnectorKnowledgeSource("source-1", scope);

    expect(mocks.invoke.mock.calls).toEqual([
      ["search_connector", {
        request: { connectorId: "github", query: "release", limit: 20 },
        workspaceId: "default",
        projectId: "project-1",
        connectionId: "connection-1"
      }],
      ["import_connector_item", {
        request: {
          connectorId: "github",
          item,
          importedAt: "2026-07-25T10:00:00.000Z"
        },
        workspaceId: "default",
        projectId: "project-1",
        connectionId: "connection-1"
      }],
      ["list_connector_knowledge_sources", {
        workspaceId: "default",
        projectId: "project-1"
      }],
      ["set_connector_knowledge_source_disabled", {
        sourceId: "source-1",
        disabled: true,
        workspaceId: "default",
        projectId: "project-1"
      }],
      ["delete_connector_knowledge_source", {
        sourceId: "source-1",
        workspaceId: "default",
        projectId: "project-1"
      }]
    ]);
  });

  it("never exposes Connector search or import through browser preview", async () => {
    const scope = { workspaceId: "default", projectId: "project-1" };
    await expect(searchRuntimeConnector(
      { connectorId: "github", query: "release" },
      scope,
      "connection-1"
    )).resolves.toBeNull();
    await expect(importRuntimeConnectorItem({
      connectorId: "github",
      item: {
        id: "issue-42",
        connectorId: "github",
        connectionId: "connection-1",
        title: "Issue 42",
        kind: "issue",
        summary: "Release blocker",
        provenance: "GitHub issue",
        freshness: "now",
        trust: "untrusted",
        providerMetadata: {}
      },
      importedAt: "2026-07-25T10:00:00.000Z"
    }, scope, "connection-1")).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

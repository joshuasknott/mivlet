import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearActiveRuntimeDataScope, setActiveRuntimeDataScope } from "../runtime-scope";
import {
  archiveRuntimeProject,
  assertRuntimeProject,
  clearPreviewProjects,
  createRuntimeProject,
  deleteRuntimeProject,
  getProjectRuntimePersistence,
  getRuntimeProject,
  listRuntimeProjectConnectionOptions,
  listRuntimeProjects,
  restoreRuntimeProject,
  updateRuntimeProject,
  type RuntimeProject
} from "./project-runtime";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

function project(overrides: Partial<RuntimeProject> = {}): RuntimeProject {
  return {
    id: "project-1" as never,
    workspaceId: "workspace-a" as never,
    authority: "local",
    visibility: "member-private",
    ownerMemberId: "member-1" as never,
    schemaVersion: 1,
    revision: 1,
    createdByInternalUserId: "user-1" as never,
    createdAt: "2026-07-11T10:00:00.000Z",
    updatedAt: "2026-07-11T10:00:00.000Z",
    title: "Project one",
    connectionIds: [],
    lifecycle: "active",
    ...overrides
  } as RuntimeProject;
}

function setNative(enabled: boolean) {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: enabled ? {} : undefined
  });
}

describe("project runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPreviewProjects();
    clearActiveRuntimeDataScope();
    setNative(false);
  });

  it("uses exact native commands and arguments without accepting a caller workspace", async () => {
    setNative(true);
    setActiveRuntimeDataScope("workspace-a");
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "project_list" ? [project()] : project()
    );

    await createRuntimeProject("workspace-a", { title: "One" });
    await listRuntimeProjects("workspace-a", true);
    await getRuntimeProject("workspace-a", "project-1");
    await updateRuntimeProject("workspace-a", { projectId: "project-1" as never, baseRevision: 1, title: "Two" });
    const transition = { projectId: "project-1" as never, baseRevision: 2 };
    await archiveRuntimeProject("workspace-a", transition);
    await restoreRuntimeProject("workspace-a", transition);
    await deleteRuntimeProject("workspace-a", transition);

    expect(mocks.invoke.mock.calls).toEqual([
      ["project_create", { input: { title: "One" } }],
      ["project_list", { includeArchived: true }],
      ["project_get", { projectId: "project-1" }],
      ["project_update", { input: { projectId: "project-1", baseRevision: 1, title: "Two" } }],
      ["project_archive", { input: transition }],
      ["project_restore", { input: transition }],
      ["project_delete", { input: transition }]
    ]);
    expect(getProjectRuntimePersistence()).toBe("native");
  });

  it("fails closed on malformed or cross-workspace native records", async () => {
    expect(() => assertRuntimeProject({ ...project(), lifecycle: "paused" }, "workspace-a"))
      .toThrow("invalid project record");
    expect(() => assertRuntimeProject(project(), "workspace-b"))
      .toThrow("invalid project record");
    expect(() => assertRuntimeProject(project({
      connectionIds: ["connection-a", "connection-a"] as never
    }), "workspace-a")).toThrow("invalid project record");

    setNative(true);
    setActiveRuntimeDataScope("workspace-a");
    await expect(listRuntimeProjects("workspace-b")).rejects.toThrow("workspace changed");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("accepts only bounded unique native Project Connection choices", async () => {
    setNative(true);
    setActiveRuntimeDataScope("workspace-a");
    mocks.invoke.mockResolvedValue([{
      connectionId: "connection-a",
      displayName: "Work GitHub",
      healthState: "healthy",
      selectable: true
    }]);
    await expect(listRuntimeProjectConnectionOptions()).resolves.toEqual([{
      connectionId: "connection-a",
      displayName: "Work GitHub",
      healthState: "healthy",
      selectable: true
    }]);
    expect(mocks.invoke).toHaveBeenCalledWith("project_connection_options");

    mocks.invoke.mockResolvedValue([
      {
        connectionId: "connection-a",
        displayName: "One",
        healthState: "healthy",
        selectable: true
      },
      {
        connectionId: "connection-a",
        displayName: "Substitute",
        healthState: "healthy",
        selectable: true
      }
    ]);
    await expect(listRuntimeProjectConnectionOptions()).rejects.toThrow(
      "invalid Project Connection list"
    );
  });

  it("keeps honest preview state isolated by workspace and revision", async () => {
    expect(getProjectRuntimePersistence()).toBe("preview-memory");
    const created = await createRuntimeProject("workspace-a", {
      title: "Preview only",
      description: "Temporary"
    });
    expect(await listRuntimeProjects("workspace-b", true)).toEqual([]);
    expect((await listRuntimeProjects("workspace-a"))[0].title).toBe("Preview only");

    await expect(updateRuntimeProject("workspace-a", {
      projectId: created.id,
      baseRevision: 99,
      title: "Stale"
    })).rejects.toThrow("changed");

    const archived = await archiveRuntimeProject("workspace-a", {
      projectId: created.id,
      baseRevision: created.revision
    });
    expect(await listRuntimeProjects("workspace-a")).toEqual([]);
    expect((await listRuntimeProjects("workspace-a", true))[0].lifecycle).toBe("archived");

    const restored = await restoreRuntimeProject("workspace-a", {
      projectId: archived.id,
      baseRevision: archived.revision
    });
    await deleteRuntimeProject("workspace-a", {
      projectId: restored.id,
      baseRevision: restored.revision
    });
    expect(await getRuntimeProject("workspace-a", restored.id)).toMatchObject({ lifecycle: "deleted" });
    expect(await listRuntimeProjects("workspace-a", true)).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearActiveRuntimeDataScope, setActiveRuntimeDataScope } from "../runtime-scope";
import { clearPreviewProjects, createRuntimeProject } from "./project-runtime";
import {
  achieveRuntimeGoal,
  archiveRuntimeGoal,
  assertRuntimeGoal,
  clearPreviewGoals,
  createRuntimeGoal,
  getRuntimeGoal,
  listRuntimeGoals,
  restoreRuntimeGoal,
  updateRuntimeGoal,
  type RuntimeGoal
} from "./goal-runtime";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

function goal(overrides: Partial<RuntimeGoal> = {}): RuntimeGoal {
  return {
    id: "goal-1" as never,
    workspaceId: "workspace-a" as never,
    authority: "local",
    visibility: "member-private",
    ownerMemberId: "member-1" as never,
    schemaVersion: 1,
    revision: 1,
    createdByInternalUserId: "user-1" as never,
    createdAt: "2026-07-11T10:00:00.000Z",
    updatedAt: "2026-07-11T10:00:00.000Z",
    title: "Ship it",
    statement: "Ship the useful outcome",
    lifecycle: "active",
    ...overrides
  } as RuntimeGoal;
}

function setNative(enabled: boolean) {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: enabled ? {} : undefined
  });
}

describe("goal runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPreviewGoals();
    clearPreviewProjects();
    clearActiveRuntimeDataScope();
    setNative(false);
  });

  it("uses exact native commands and preserves all versus workspace-level filters", async () => {
    setNative(true);
    setActiveRuntimeDataScope("workspace-a");
    mocks.invoke.mockImplementation(async (command: string, args?: { input?: { projectId?: string | null } }) =>
      command === "goal_list"
        ? [goal(args?.input?.projectId ? { projectId: args.input.projectId as never } : {})]
        : goal()
    );

    await createRuntimeGoal("workspace-a", { title: "Ship it", statement: "Do the work" });
    await listRuntimeGoals("workspace-a");
    await listRuntimeGoals("workspace-a", null);
    await listRuntimeGoals("workspace-a", "project-a");
    await getRuntimeGoal("workspace-a", "goal-1");
    await updateRuntimeGoal("workspace-a", { goalId: "goal-1" as never, baseRevision: 1, title: "Ship well" });
    const transition = { goalId: "goal-1" as never, baseRevision: 2 };
    await achieveRuntimeGoal("workspace-a", transition);
    await archiveRuntimeGoal("workspace-a", transition);
    await restoreRuntimeGoal("workspace-a", transition);

    expect(mocks.invoke.mock.calls).toEqual([
      ["goal_create", { input: { title: "Ship it", statement: "Do the work" } }],
      ["goal_list", { input: {} }],
      ["goal_list", { input: { projectId: null } }],
      ["goal_list", { input: { projectId: "project-a" } }],
      ["goal_get", { goalId: "goal-1" }],
      ["goal_update", { input: { goalId: "goal-1", baseRevision: 1, title: "Ship well" } }],
      ["goal_achieve", { input: transition }],
      ["goal_archive", { input: transition }],
      ["goal_restore", { input: transition }]
    ]);
  });

  it("fails closed on malformed, cross-workspace, or out-of-filter native data", async () => {
    expect(() => assertRuntimeGoal({ ...goal(), lifecycle: "deleted" }, "workspace-a"))
      .toThrow("invalid goal record");
    expect(() => assertRuntimeGoal(goal(), "workspace-b")).toThrow("invalid goal record");

    setNative(true);
    setActiveRuntimeDataScope("workspace-a");
    mocks.invoke.mockResolvedValue([goal({ projectId: "project-a" as never })]);
    await expect(listRuntimeGoals("workspace-a", null)).rejects.toThrow("outside the requested project scope");
    await expect(listRuntimeGoals("workspace-b")).rejects.toThrow("workspace changed");
  });

  it("isolates preview goals and enforces same-workspace active projects and revisions", async () => {
    const project = await createRuntimeProject("workspace-a", { title: "Project A" });
    const created = await createRuntimeGoal("workspace-a", {
      projectId: project.id,
      title: "Project goal",
      statement: "Stay isolated"
    });
    await createRuntimeGoal("workspace-a", { title: "Workspace goal", statement: "No project" });

    expect(await listRuntimeGoals("workspace-b")).toEqual([]);
    expect(await listRuntimeGoals("workspace-a", project.id)).toHaveLength(1);
    expect(await listRuntimeGoals("workspace-a", null)).toHaveLength(1);
    await expect(createRuntimeGoal("workspace-b", {
      projectId: project.id,
      title: "Leak",
      statement: "Must fail"
    })).rejects.toThrow("project is unavailable");
    await expect(updateRuntimeGoal("workspace-a", {
      goalId: created.id,
      baseRevision: 99,
      title: "Stale"
    })).rejects.toThrow("changed");

    const achieved = await achieveRuntimeGoal("workspace-a", {
      goalId: created.id,
      baseRevision: created.revision
    });
    expect(achieved.lifecycle).toBe("achieved");
  });
});

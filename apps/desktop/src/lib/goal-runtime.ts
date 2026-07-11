import type { Spine } from "@fable/protocol";
import { invoke } from "@tauri-apps/api/core";
import { getActiveRuntimeDataScope } from "../runtime-scope";
import { hasTauriRuntime } from "./persistence";
import { getRuntimeProject } from "./project-runtime";

export type RuntimeGoal = Spine.Goals.Goal;
export type RuntimeGoalCreate = Spine.Goals.GoalCreateInput;
export type RuntimeGoalUpdate = Spine.Goals.GoalUpdateInput;
export type RuntimeGoalTransition = Spine.Goals.GoalTransitionInput;
export type GoalProjectFilter = string | null | undefined;
export type GoalRuntimePersistence = "native" | "preview-memory";

const previewGoals = new Map<string, Map<string, RuntimeGoal>>();
let previewGoalSequence = 0;

function runtimeError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return new Error(error.message);
  }
  return new Error(typeof error === "string" ? error : "Fable could not complete the goal request.");
}

function requireWorkspaceId(workspaceId: string): string {
  const normalized = workspaceId.trim();
  if (!normalized) throw new Error("An active workspace is required for goals.");
  if (hasTauriRuntime()) {
    const active = getActiveRuntimeDataScope();
    if (!active || active.workspaceId !== normalized) {
      throw new Error("The active goal workspace changed. Refresh and try again.");
    }
  }
  return normalized;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject drifted native data before it can enter a workspace-scoped cache. */
export function assertRuntimeGoal(value: unknown, workspaceId: string): RuntimeGoal {
  if (!isObject(value)) throw new Error("Fable returned an invalid goal record.");
  const validAuthority =
    (value.authority === "local" && value.visibility === "member-private" && typeof value.ownerMemberId === "string") ||
    (value.authority === "convex" && value.visibility === "workspace-shared" && value.ownerMemberId === undefined);
  if (
    typeof value.id !== "string" || !value.id ||
    value.workspaceId !== workspaceId ||
    !validAuthority ||
    typeof value.schemaVersion !== "number" || !Number.isInteger(value.schemaVersion) || value.schemaVersion < 1 ||
    typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 0 ||
    typeof value.createdByInternalUserId !== "string" || !value.createdByInternalUserId ||
    typeof value.createdAt !== "string" || !value.createdAt ||
    typeof value.updatedAt !== "string" || !value.updatedAt ||
    (value.projectId !== undefined && (typeof value.projectId !== "string" || !value.projectId)) ||
    typeof value.title !== "string" || !value.title ||
    typeof value.statement !== "string" || !value.statement ||
    value.deletedAt !== undefined ||
    (value.lifecycle !== "active" && value.lifecycle !== "achieved" && value.lifecycle !== "archived")
  ) {
    throw new Error("Fable returned an invalid goal record.");
  }
  return value as RuntimeGoal;
}

function previewStore(workspaceId: string) {
  let store = previewGoals.get(workspaceId);
  if (!store) {
    store = new Map();
    previewGoals.set(workspaceId, store);
  }
  return store;
}

async function requirePreviewProject(workspaceId: string, projectId?: string | null) {
  if (!projectId) return;
  const project = await getRuntimeProject(workspaceId, projectId);
  if (!project || project.lifecycle !== "active") {
    throw new Error("This goal project is unavailable.");
  }
}

function requirePreviewGoal(workspaceId: string, goalId: string, baseRevision?: number) {
  const goal = previewStore(workspaceId).get(goalId);
  if (!goal) throw new Error("This goal is unavailable.");
  if (baseRevision !== undefined && goal.revision !== baseRevision) {
    throw new Error("This goal changed. Refresh and try again.");
  }
  return goal;
}

function updatePreviewGoal(workspaceId: string, goal: RuntimeGoal, patch: Partial<RuntimeGoal>) {
  const updated = {
    ...goal,
    ...patch,
    revision: goal.revision + 1,
    updatedAt: new Date().toISOString()
  } as RuntimeGoal;
  previewStore(workspaceId).set(goal.id, updated);
  return updated;
}

function matchesProjectFilter(goal: RuntimeGoal, projectId: GoalProjectFilter) {
  if (projectId === undefined) return true;
  return (goal.projectId ?? null) === projectId;
}

export function getGoalRuntimePersistence(): GoalRuntimePersistence {
  return hasTauriRuntime() ? "native" : "preview-memory";
}

export async function listRuntimeGoals(workspaceId: string, projectId?: string | null) {
  const workspace = requireWorkspaceId(workspaceId);
  if (!hasTauriRuntime()) {
    return [...previewStore(workspace).values()]
      .filter((goal) => matchesProjectFilter(goal, projectId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  try {
    const input = projectId === undefined ? {} : { projectId };
    const result = await invoke<unknown>("goal_list", { input });
    if (!Array.isArray(result)) throw new Error("Fable returned an invalid goal list.");
    const goals = result.map((goal) => assertRuntimeGoal(goal, workspace));
    if (goals.some((goal) => !matchesProjectFilter(goal, projectId))) {
      throw new Error("Fable returned a goal outside the requested project scope.");
    }
    return goals;
  } catch (error) {
    throw runtimeError(error);
  }
}

export async function getRuntimeGoal(workspaceId: string, goalId: string) {
  const workspace = requireWorkspaceId(workspaceId);
  if (!hasTauriRuntime()) return previewStore(workspace).get(goalId) ?? null;
  try {
    const result = await invoke<unknown>("goal_get", { goalId });
    return result === null ? null : assertRuntimeGoal(result, workspace);
  } catch (error) {
    throw runtimeError(error);
  }
}

export async function createRuntimeGoal(workspaceId: string, input: RuntimeGoalCreate) {
  const workspace = requireWorkspaceId(workspaceId);
  if (!hasTauriRuntime()) {
    await requirePreviewProject(workspace, input.projectId);
    const now = new Date().toISOString();
    previewGoalSequence += 1;
    const goal = {
      id: `preview-goal-${previewGoalSequence}` as never,
      workspaceId: workspace as never,
      authority: "local",
      visibility: "member-private",
      ownerMemberId: "preview-member" as never,
      schemaVersion: 1,
      revision: 1,
      createdByInternalUserId: "preview-user" as never,
      createdAt: now,
      updatedAt: now,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      title: input.title.trim(),
      statement: input.statement.trim(),
      lifecycle: "active"
    } as RuntimeGoal;
    previewStore(workspace).set(goal.id, goal);
    return goal;
  }
  try {
    return assertRuntimeGoal(await invoke<unknown>("goal_create", { input }), workspace);
  } catch (error) {
    throw runtimeError(error);
  }
}

export async function updateRuntimeGoal(workspaceId: string, input: RuntimeGoalUpdate) {
  const workspace = requireWorkspaceId(workspaceId);
  if (!hasTauriRuntime()) {
    const goal = requirePreviewGoal(workspace, input.goalId, input.baseRevision);
    if (input.projectId !== undefined) await requirePreviewProject(workspace, input.projectId);
    return updatePreviewGoal(workspace, goal, {
      ...(input.projectId === undefined ? {} : { projectId: input.projectId ?? undefined }),
      ...(input.title === undefined ? {} : { title: input.title.trim() }),
      ...(input.statement === undefined ? {} : { statement: input.statement.trim() })
    });
  }
  try {
    return assertRuntimeGoal(await invoke<unknown>("goal_update", { input }), workspace);
  } catch (error) {
    throw runtimeError(error);
  }
}

async function transitionRuntimeGoal(
  command: "goal_achieve" | "goal_archive" | "goal_restore",
  workspaceId: string,
  input: RuntimeGoalTransition
) {
  const workspace = requireWorkspaceId(workspaceId);
  if (!hasTauriRuntime()) {
    const goal = requirePreviewGoal(workspace, input.goalId, input.baseRevision);
    const lifecycle = command === "goal_achieve" ? "achieved" : command === "goal_archive" ? "archived" : "active";
    return updatePreviewGoal(workspace, goal, { lifecycle });
  }
  try {
    return assertRuntimeGoal(await invoke<unknown>(command, { input }), workspace);
  } catch (error) {
    throw runtimeError(error);
  }
}

export const achieveRuntimeGoal = (workspaceId: string, input: RuntimeGoalTransition) =>
  transitionRuntimeGoal("goal_achieve", workspaceId, input);
export const archiveRuntimeGoal = (workspaceId: string, input: RuntimeGoalTransition) =>
  transitionRuntimeGoal("goal_archive", workspaceId, input);
export const restoreRuntimeGoal = (workspaceId: string, input: RuntimeGoalTransition) =>
  transitionRuntimeGoal("goal_restore", workspaceId, input);

export function clearPreviewGoals(workspaceId?: string) {
  if (workspaceId) previewGoals.delete(workspaceId);
  else previewGoals.clear();
}

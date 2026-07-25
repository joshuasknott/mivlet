import type { Spine } from "@fable/protocol";
import { invoke } from "@tauri-apps/api/core";
import { getActiveRuntimeDataScope } from "../runtime-scope";
import { hasTauriRuntime } from "./persistence";

export type RuntimeProject = Spine.Projects.Project;
export type RuntimeProjectCreate = Spine.Projects.ProjectCreateInput;
export type RuntimeProjectUpdate = Spine.Projects.ProjectUpdateInput;
export type RuntimeProjectTransition = Spine.Projects.ProjectTransitionInput;
export type ProjectRuntimePersistence = "native" | "preview-memory";

export interface RuntimeProjectConnectionOption {
  connectionId: string;
  displayName: string;
  healthState: string;
  selectable: boolean;
}

const previewProjects = new Map<string, Map<string, RuntimeProject>>();
let previewProjectSequence = 0;

function runtimeError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return new Error(error.message);
  }
  return new Error(typeof error === "string" ? error : "Fable could not complete the project request.");
}

function requireWorkspaceId(workspaceId: string): string {
  const normalized = workspaceId.trim();
  if (!normalized) throw new Error("An active workspace is required for projects.");
  if (hasTauriRuntime()) {
    const active = getActiveRuntimeDataScope();
    if (!active || active.workspaceId !== normalized) {
      throw new Error("The active project workspace changed. Refresh and try again.");
    }
  }
  return normalized;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/** Fail closed if a native adapter drifts from the canonical project contract. */
export function assertRuntimeProject(value: unknown, workspaceId: string): RuntimeProject {
  if (!isObject(value)) throw new Error("Fable returned an invalid project record.");
  const lifecycle = value.lifecycle;
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
    typeof value.title !== "string" || !value.title ||
    !optionalString(value.description) ||
    !optionalString(value.instructions) ||
    (
      value.connectionIds !== undefined
      && (
        !Array.isArray(value.connectionIds)
        || value.connectionIds.length > 32
        || value.connectionIds.some((id) => typeof id !== "string" || !id.trim())
        || new Set(value.connectionIds).size !== value.connectionIds.length
      )
    ) ||
    !optionalString(value.deletedAt) ||
    (lifecycle !== "active" && lifecycle !== "archived" && lifecycle !== "deleted")
  ) {
    throw new Error("Fable returned an invalid project record.");
  }
  return value as RuntimeProject;
}

function previewStore(workspaceId: string) {
  let store = previewProjects.get(workspaceId);
  if (!store) {
    store = new Map();
    previewProjects.set(workspaceId, store);
  }
  return store;
}

function previewProject(workspaceId: string, input: RuntimeProjectCreate): RuntimeProject {
  const now = new Date().toISOString();
  previewProjectSequence += 1;
  return {
    id: `preview-project-${previewProjectSequence}` as never,
    workspaceId: workspaceId as never,
    authority: "local",
    visibility: "member-private",
    ownerMemberId: "preview-member" as never,
    schemaVersion: 1,
    revision: 1,
    createdByInternalUserId: "preview-user" as never,
    createdAt: now,
    updatedAt: now,
    title: input.title.trim(),
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    ...(input.instructions?.trim() ? { instructions: input.instructions.trim() } : {}),
    connectionIds: [],
    lifecycle: "active"
  };
}

function requirePreviewProject(workspaceId: string, projectId: string, baseRevision?: number) {
  const project = previewStore(workspaceId).get(projectId);
  if (!project || project.lifecycle === "deleted") throw new Error("This project is unavailable.");
  if (baseRevision !== undefined && project.revision !== baseRevision) {
    throw new Error("This project changed. Refresh and try again.");
  }
  return project;
}

function updatePreviewProject(
  workspaceId: string,
  project: RuntimeProject,
  patch: Partial<RuntimeProject>
): RuntimeProject {
  const updated = {
    ...project,
    ...patch,
    revision: project.revision + 1,
    updatedAt: new Date().toISOString()
  } as RuntimeProject;
  previewStore(workspaceId).set(project.id, updated);
  return updated;
}

export function getProjectRuntimePersistence(): ProjectRuntimePersistence {
  return hasTauriRuntime() ? "native" : "preview-memory";
}

export async function listRuntimeProjects(workspaceId: string, includeArchived = false) {
  const workspace = requireWorkspaceId(workspaceId);
  if (!hasTauriRuntime()) {
    return [...previewStore(workspace).values()]
      .filter((project) => project.lifecycle === "active" || (includeArchived && project.lifecycle === "archived"))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  try {
    const result = await invoke<unknown>("project_list", { includeArchived });
    if (!Array.isArray(result)) throw new Error("Fable returned an invalid project list.");
    return result.map((project) => assertRuntimeProject(project, workspace));
  } catch (error) {
    throw runtimeError(error);
  }
}

export async function getRuntimeProject(workspaceId: string, projectId: string) {
  const workspace = requireWorkspaceId(workspaceId);
  if (!hasTauriRuntime()) return previewStore(workspace).get(projectId) ?? null;
  try {
    const result = await invoke<unknown>("project_get", { projectId });
    return result === null ? null : assertRuntimeProject(result, workspace);
  } catch (error) {
    throw runtimeError(error);
  }
}

export async function createRuntimeProject(workspaceId: string, input: RuntimeProjectCreate) {
  const workspace = requireWorkspaceId(workspaceId);
  if (!hasTauriRuntime()) {
    const project = previewProject(workspace, input);
    previewStore(workspace).set(project.id, project);
    return project;
  }
  try {
    return assertRuntimeProject(await invoke<unknown>("project_create", { input }), workspace);
  } catch (error) {
    throw runtimeError(error);
  }
}

export async function updateRuntimeProject(workspaceId: string, input: RuntimeProjectUpdate) {
  const workspace = requireWorkspaceId(workspaceId);
  if (!hasTauriRuntime()) {
    const project = requirePreviewProject(workspace, input.projectId, input.baseRevision);
    return updatePreviewProject(workspace, project, {
      ...(input.title === undefined ? {} : { title: input.title.trim() }),
      ...(input.description === undefined ? {} : { description: input.description?.trim() || undefined }),
      ...(input.instructions === undefined ? {} : { instructions: input.instructions?.trim() || undefined }),
      ...(input.connectionIds === undefined ? {} : { connectionIds: [...input.connectionIds] })
    });
  }
  try {
    return assertRuntimeProject(await invoke<unknown>("project_update", { input }), workspace);
  } catch (error) {
    throw runtimeError(error);
  }
}

export async function listRuntimeProjectConnectionOptions(): Promise<RuntimeProjectConnectionOption[]> {
  if (!hasTauriRuntime()) return [];
  try {
    const result = await invoke<RuntimeProjectConnectionOption[]>("project_connection_options");
    if (
      !Array.isArray(result)
      || result.length > 256
      || result.some((option) =>
        !option
        || typeof option.connectionId !== "string"
        || typeof option.displayName !== "string"
        || typeof option.healthState !== "string"
        || typeof option.selectable !== "boolean"
      )
      || new Set(result.map((option) => option.connectionId)).size !== result.length
    ) {
      throw new Error("Fable returned an invalid Project Connection list.");
    }
    return result;
  } catch (error) {
    throw runtimeError(error);
  }
}

async function transitionRuntimeProject(
  command: "project_archive" | "project_restore" | "project_delete",
  workspaceId: string,
  input: RuntimeProjectTransition
) {
  const workspace = requireWorkspaceId(workspaceId);
  if (!hasTauriRuntime()) {
    const project = requirePreviewProject(workspace, input.projectId, input.baseRevision);
    const lifecycle = command === "project_archive" ? "archived" : command === "project_restore" ? "active" : "deleted";
    return updatePreviewProject(workspace, project, {
      lifecycle,
      ...(lifecycle === "deleted" ? { deletedAt: new Date().toISOString() } : {})
    });
  }
  try {
    return assertRuntimeProject(await invoke<unknown>(command, { input }), workspace);
  } catch (error) {
    throw runtimeError(error);
  }
}

export const archiveRuntimeProject = (workspaceId: string, input: RuntimeProjectTransition) =>
  transitionRuntimeProject("project_archive", workspaceId, input);
export const restoreRuntimeProject = (workspaceId: string, input: RuntimeProjectTransition) =>
  transitionRuntimeProject("project_restore", workspaceId, input);
export const deleteRuntimeProject = (workspaceId: string, input: RuntimeProjectTransition) =>
  transitionRuntimeProject("project_delete", workspaceId, input);

/** Clears only non-durable preview state, for sign-out/tests. Native data is untouched. */
export function clearPreviewProjects(workspaceId?: string) {
  if (workspaceId) previewProjects.delete(workspaceId);
  else previewProjects.clear();
}

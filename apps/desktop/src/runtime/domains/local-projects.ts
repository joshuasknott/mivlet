import type {
  BindLocalProjectRunAuthorInput,
  CreateLocalProjectInput,
  LocalProject,
  LocalProjectRunAuthor,
  UpdateLocalProjectInput,
} from "@fable/protocol";
import { getRuntimeAdapter } from "../adapters/select";
import { toRuntimeError } from "../errors";

async function invoke<T>(command: string, request: object): Promise<T> {
  const adapter = getRuntimeAdapter();
  if (adapter.kind === "preview") {
    throw new Error("Projects require the installed desktop app.");
  }
  try {
    return await adapter.invoke<T>(command, { request });
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export const createLocalProject = (request: CreateLocalProjectInput) =>
  invoke<LocalProject>("local_project_create", request);

export const listLocalProjects = (
  workspaceId: string,
  includeArchived = false,
) =>
  invoke<LocalProject[]>("local_project_list", {
    workspaceId,
    includeArchived,
  });

export const updateLocalProject = (request: UpdateLocalProjectInput) =>
  invoke<LocalProject>("local_project_update", request);

export const archiveLocalProject = (request: {
  workspaceId: string;
  id: string;
  expectedRevision: number;
}) => invoke<LocalProject>("local_project_archive", request);

export const bindLocalProjectRunAuthor = (
  request: BindLocalProjectRunAuthorInput,
) => invoke<LocalProjectRunAuthor>("local_project_run_author_bind", request);

export const listLocalProjectRunAuthors = (
  workspaceId: string,
  projectId: string,
  limit = 100,
) =>
  invoke<LocalProjectRunAuthor[]>("local_project_run_author_list", {
    workspaceId,
    projectId,
    limit,
  });

export const getLocalProjectRunAuthor = (
  workspaceId: string,
  projectId: string,
  runId: string,
) =>
  invoke<LocalProjectRunAuthor | null>("local_project_run_author_get", {
    workspaceId,
    projectId,
    runId,
  });

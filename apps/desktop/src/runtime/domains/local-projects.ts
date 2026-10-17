import type {
  AddProjectContextShareInput,
  CreateLocalProjectInput,
  LocalProject,
  LocalProjectRunAuthor,
  MigrateLegacyGroupInput,
  RemoveProjectContextShareInput,
  UpdateLocalProjectInput,
} from "@mivlet/protocol";
import { invokeRequiredNative } from "../required-native";

const invoke = <T>(command: string, request: object): Promise<T> =>
  invokeRequiredNative<T>(
    command,
    { request },
    "Projects require the installed desktop app.",
  );

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

export const addLocalProjectShare = (request: AddProjectContextShareInput) =>
  invoke<LocalProject>("local_project_share_add", request);

export const removeLocalProjectShare = (
  request: RemoveProjectContextShareInput,
) => invoke<LocalProject>("local_project_share_remove", request);

/** Converts a legacy standalone group into a project owning its existing thread. */
export const migrateLegacyGroup = (request: MigrateLegacyGroupInput) =>
  invoke<LocalProject>("local_project_migrate_group", request);

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

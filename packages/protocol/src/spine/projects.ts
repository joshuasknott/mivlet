import type {
  MemberId,
  ProjectId,
  ScopedRecordMetadata
} from "./primitives.js";

/** Portable bounds; adapters may impose smaller limits but never larger ones. */
export const PROJECT_TITLE_MAX_CHARACTERS = 200;
export const PROJECT_DESCRIPTION_MAX_CHARACTERS = 4_000;
export const PROJECT_INSTRUCTIONS_MAX_CHARACTERS = 32_000;

export const PROJECT_LIFECYCLE_STATES = ["active", "archived", "deleted"] as const;
export type ProjectLifecycleState = (typeof PROJECT_LIFECYCLE_STATES)[number];

export const PROJECT_MUTATION_OPERATIONS = [
  "create",
  "update",
  "archive",
  "restore",
  "delete"
] as const;
export type ProjectMutationOperation = (typeof PROJECT_MUTATION_OPERATIONS)[number];

/** Local projects stay member-private; explicitly shared projects are Convex-owned. */
export type ProjectAuthorityScope =
  | {
      authority: "local";
      visibility: "member-private";
      ownerMemberId: MemberId;
    }
  | {
      authority: "convex";
      visibility: "workspace-shared";
      ownerMemberId?: never;
    };

export type ProjectRecordMetadata = Omit<
  ScopedRecordMetadata,
  "authority" | "visibility" | "ownerMemberId"
> &
  ProjectAuthorityScope;

/**
 * An optional workspace context. Archiving is reversible; deletion is a
 * tombstone transition and must detach contextual links without deleting the
 * linked workspace-owned records.
 */
export type Project = Readonly<ProjectRecordMetadata> & {
  readonly id: ProjectId;
  readonly title: string;
  readonly description?: string;
  readonly instructions?: string;
  readonly lifecycle: ProjectLifecycleState;
};

export interface ProjectCreateInput {
  title: string;
  description?: string;
  instructions?: string;
}

export interface ProjectUpdateInput {
  projectId: ProjectId;
  baseRevision: number;
  title?: string;
  description?: string | null;
  instructions?: string | null;
}

export interface ProjectTransitionInput {
  projectId: ProjectId;
  baseRevision: number;
}

import type {
  GoalId,
  MemberId,
  ProjectId,
  ScopedRecordMetadata
} from "./primitives.js";

export const GOAL_TITLE_MAX_CHARACTERS = 200;
export const GOAL_STATEMENT_MAX_CHARACTERS = 8_000;

export const GOAL_LIFECYCLE_STATES = ["active", "achieved", "archived"] as const;
export type GoalLifecycleState = (typeof GOAL_LIFECYCLE_STATES)[number];

export const GOAL_MUTATION_OPERATIONS = [
  "create",
  "update",
  "achieve",
  "archive",
  "restore"
] as const;
export type GoalMutationOperation = (typeof GOAL_MUTATION_OPERATIONS)[number];

export type GoalAuthorityScope =
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

export type GoalRecordMetadata = Omit<
  ScopedRecordMetadata,
  "authority" | "visibility" | "ownerMemberId"
> &
  GoalAuthorityScope;

/** A durable desired outcome. Project context is optional and removable. */
export type Goal = Readonly<Omit<GoalRecordMetadata, "deletedAt">> & {
  readonly deletedAt?: never;
  readonly id: GoalId;
  readonly projectId?: ProjectId;
  readonly title: string;
  readonly statement: string;
  readonly lifecycle: GoalLifecycleState;
};

export interface GoalCreateInput {
  projectId?: ProjectId;
  title: string;
  statement: string;
}

/** Omitted lists all goals; null selects only workspace-level goals. */
export interface GoalListInput {
  projectId?: ProjectId | null;
}

export interface GoalUpdateInput {
  goalId: GoalId;
  baseRevision: number;
  projectId?: ProjectId | null;
  title?: string;
  statement?: string;
}

export interface GoalTransitionInput {
  goalId: GoalId;
  baseRevision: number;
}

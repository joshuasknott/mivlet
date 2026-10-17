import type { ApprovalRequest } from "./approvals.js";
import type { CollaborationSnapshot } from "./collaboration.js";
import type { HostedTaskAdmission, HostedTaskResult } from "./hosted-tasks.js";

/** Native control replies compose local Work with the separate cloud receipt. */
export interface HostedTaskReview {
  collaboration: CollaborationSnapshot;
  runnerUrl: string;
  reviewId: string;
  workId: string;
  workGeneration: number;
  admission: HostedTaskAdmission;
  inputBytes: number;
  expiresAt: number;
  originallyHeld: boolean;
  approval: ApprovalRequest;
}
export interface HostedTaskControlResult {
  collaboration: CollaborationSnapshot;
  taskResult?: HostedTaskResult;
  reconcileRequired: boolean;
}

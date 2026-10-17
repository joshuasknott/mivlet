import type { ApprovalRequest, ApprovalResolutionRequest } from "./approvals.js";

/** Metadata only. Repository bytes use authenticated native/runner transport. */
export const HOSTED_REPOSITORY_LIMITS = {
  fileBytes: 256 * 1024,
  treeBytes: 32 * 1024 * 1024,
  files: 2_000,
  chunkBytes: 64 * 1024,
  retainedSnapshots: 4,
  reviewMs: 120_000,
} as const;

export interface HostedRepositoryFile {
  path: string;
  sizeBytes: number;
  sha256: string;
}
export interface HostedRepositorySnapshot {
  version: 1;
  snapshotId: string;
  repositoryId: string;
  branch: string;
  baseCommit: string;
  inputTreeId: string;
  manifestSha256: string;
  files: HostedRepositoryFile[];
  /** Exact writable names, including any explicitly proposed new files. */
  writablePaths: string[];
  totalBytes: number;
}
/** A complete output file set, with explicit deletions of exported input files. */
export interface HostedRepositoryOutputManifest {
  version: 1;
  snapshotId: string;
  inputManifestSha256: string;
  outputManifestSha256: string;
  files: HostedRepositoryFile[];
  deletedPaths: string[];
  totalBytes: number;
}
export interface HostedRepositoryTarget {
  workspaceId: string;
  agentId: string;
  workId: string;
  expectedGeneration: number;
}
export interface HostedRepositoryCandidate {
  path: string;
  sizeBytes: number;
}
export interface HostedRepositoryCandidates {
  repositoryId: string;
  files: HostedRepositoryCandidate[];
  truncated: boolean;
}
export interface HostedRepositoryImportTarget extends HostedRepositoryTarget {
  snapshotId: string;
  outputManifestSha256: string;
}
export interface HostedRepositoryImportReview {
  reviewId: string;
  snapshot: HostedRepositorySnapshot;
  output: HostedRepositoryOutputManifest;
  currentTreeId: string;
  outputTreeId: string;
  head: string;
  computerGeneration: number;
  expiresAt: number;
  changes: { path: string; status: "added" | "modified" | "deleted"; beforeSha256?: string; afterSha256?: string }[];
  diff: string;
  truncated: boolean;
  approval: ApprovalRequest;
}
export interface HostedRepositoryImportCommit extends HostedRepositoryImportTarget {
  reviewId: string;
  resolution: ApprovalResolutionRequest;
}
export interface HostedRepositoryImportReceipt {
  snapshotId: string;
  repositoryId: string;
  outputManifestSha256: string;
  outputTreeId: string;
  beforeImportCheckpointId: string;
  verificationInvalidated: true;
}

/** Native private-copy file checkpoints, independent of conversation branches. */
export interface RepositoryCheckpoint {
  id: string;
  repositoryId: string;
  label: string;
  treeId: string;
  head: string;
  createdAt: string;
  bytes: number;
  fileCount: number;
  requestId: string;
  generation: number;
  reason: "manual" | "before-restore";
}
export interface RepositoryCheckpointList {
  checkpoints: RepositoryCheckpoint[];
  maxCheckpoints: number;
  maxBytes: number;
}
export interface RepositoryCheckpointPreview {
  checkpoint: RepositoryCheckpoint;
  currentTreeId: string;
  outputTreeId: string;
  head: string;
  files: Array<{
    path: string;
    status: "added" | "deleted" | "modified";
    beforeSha256: string | null;
    afterSha256: string | null;
  }>;
  diff: string;
  truncated: boolean;
  preservesIgnoredFiles: boolean;
  verificationWillBeInvalidated: boolean;
}

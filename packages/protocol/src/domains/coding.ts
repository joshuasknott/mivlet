/** Credential-free repository projection. Native paths and Git credentials stay native. */
export interface RepositoryCommandResult {
  exitCode: number | null;
  output: string;
  truncated: boolean;
  interrupted: boolean;
}
export interface CodingRepository {
  id: string;
  name: string;
  branch: string;
  base: string;
  baseBranch: string;
  remote: string | null;
  operation: string;
  lastResult: RepositoryCommandResult | null;
  lastCommand: string | null;
  commandDiffId: string | null;
  publication: string | null;
}
export interface CodingRepositoryStatus {
  repository: CodingRepository | null;
  busy?: boolean;
  recoveryRequired?: boolean;
  changes?: {
    head: string;
    diffId: string;
    diff: string;
    files: string;
    truncated: boolean;
  } | null;
}

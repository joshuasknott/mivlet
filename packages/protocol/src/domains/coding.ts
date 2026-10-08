/** Credential-free repository projection. Native paths and Git credentials stay native. */
export interface RepositoryCommandResult {
  exitCode: number | null;
  output: string;
  truncated: boolean;
  interrupted: boolean;
  execution?: NativeExecutionReceipt;
}
export interface NativeExecutionReceipt {
  runId: string;
  executor: string;
  runtimeId: string;
  inputId: string;
  outputId: string | null;
  commandId: string;
  binding: { scopeId: string; generation: number; operationId: number };
  elapsedMs: number;
  network: boolean;
  persistent?: boolean;
  reason: string | null;
}
export interface NativeExecutionStatus {
  available: boolean;
  message: string | null;
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

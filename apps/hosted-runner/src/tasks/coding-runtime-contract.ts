import type { HostedCodingScope, HostedRepositoryFile } from "@mivlet/protocol";

export interface CodingCheckStart {
  leaseId: string; taskSha256: string; stepId: string; deadline: number;
  scope: HostedCodingScope; files: HostedRepositoryFile[]; candidateSha256: string;
}
export interface CodingCheckResult {
  leaseId: string; stepId: string; candidateSha256: string; id: string;
  exitCode: number; stdout: string; stderr: string; truncated: boolean; timedOut: boolean;
}
/** Private service RPC only. No fetch proxy, host path or provider key API. */
export interface CodingRuntimeBinding {
  prerequisites(image: string): Promise<{ image: string; network: "disabled"; proof: "positive-and-negative-v1" }>;
  begin(value: CodingCheckStart): Promise<void>;
  file(leaseId: string, path: string, content: string): Promise<void>;
  run(leaseId: string, checkId: string): Promise<CodingCheckResult>;
  cancel(leaseId: string): Promise<void>;
}

import type { HostedCodingTaskPrepare, HostedRepositoryCandidates, HostedRepositoryImportCommit, HostedRepositoryImportReceipt, HostedRepositoryImportReview, HostedRepositoryImportTarget, HostedRepositoryTarget, HostedTaskReview } from "@mivlet/protocol";

export interface HostedCodingApi {
  prepare: (request: HostedCodingTaskPrepare) => Promise<HostedTaskReview>;
  candidates: (request: HostedRepositoryTarget) => Promise<HostedRepositoryCandidates>;
  reviewImport: (request: HostedRepositoryImportTarget) => Promise<HostedRepositoryImportReview>;
  applyImport: (request: HostedRepositoryImportCommit) => Promise<HostedRepositoryImportReceipt>;
}

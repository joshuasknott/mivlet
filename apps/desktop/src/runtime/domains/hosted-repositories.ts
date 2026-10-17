import type { HostedRepositoryCandidates, HostedRepositoryImportCommit, HostedRepositoryImportReceipt, HostedRepositoryImportReview, HostedRepositoryImportTarget, HostedRepositoryTarget } from "@mivlet/protocol";
import { getRuntimeAdapter } from "../adapters/select";
import { toRuntimeError } from "../errors";

async function invoke<T>(command: string, request: object): Promise<T> {
  const adapter = getRuntimeAdapter();
  if (adapter.kind !== "native") throw new Error("Hosted source review and file import require the installed Mivlet desktop app.");
  try { return await adapter.invoke<T>(command, { request }); }
  catch (error) { throw toRuntimeError(error); }
}
export const listHostedRepositoryCandidates = (request: HostedRepositoryTarget) =>
  invoke<HostedRepositoryCandidates>("hosted_repository_candidates", request);
export const reviewHostedRepositoryImport = (request: HostedRepositoryImportTarget) =>
  invoke<HostedRepositoryImportReview>("hosted_repository_import_review", request);
export const applyHostedRepositoryImport = (request: HostedRepositoryImportCommit) =>
  invoke<HostedRepositoryImportReceipt>("hosted_repository_import_apply", request);
export const readHostedRepositoryImportReceipt = (request: HostedRepositoryImportTarget) =>
  invoke<HostedRepositoryImportReceipt | null>("hosted_repository_import_receipt", request);

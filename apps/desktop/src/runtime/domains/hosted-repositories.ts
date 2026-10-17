import type {
  HostedRepositoryCandidates,
  HostedRepositoryImportCommit,
  HostedRepositoryImportReceipt,
  HostedRepositoryImportReview,
  HostedRepositoryImportTarget,
  HostedRepositoryTarget,
} from "@mivlet/protocol";
import { invokeRequiredNative } from "../required-native";

const invoke = <T>(command: string, request: object): Promise<T> =>
  invokeRequiredNative<T>(
    command,
    { request },
    "Hosted source review and file import require the installed Mivlet desktop app.",
  );
export const listHostedRepositoryCandidates = (
  request: HostedRepositoryTarget,
) =>
  invoke<HostedRepositoryCandidates>("hosted_repository_candidates", request);
export const reviewHostedRepositoryImport = (
  request: HostedRepositoryImportTarget,
) =>
  invoke<HostedRepositoryImportReview>(
    "hosted_repository_import_review",
    request,
  );
export const applyHostedRepositoryImport = (
  request: HostedRepositoryImportCommit,
) =>
  invoke<HostedRepositoryImportReceipt>(
    "hosted_repository_import_apply",
    request,
  );

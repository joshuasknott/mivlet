import type {
  HostedProviderConnection,
  HostedProviderEnroll,
  HostedProviderRevoke,
  HostedProviderScope,
  HostedTaskCommit,
  HostedTaskControlResult,
  HostedTaskPrepare,
  HostedPublicWebTaskPrepare,
  HostedTaskReview,
  HostedTaskReviewTarget,
  HostedTaskTarget,
} from "@mivlet/protocol";
import { getRuntimeAdapter } from "../adapters/select";
import { toRuntimeError } from "../errors";

async function invoke<T>(command: string, request: object): Promise<T> {
  const adapter = getRuntimeAdapter();
  if (adapter.kind !== "native")
    throw new Error(
      "Cloud tasks require the installed desktop app and a separately connected cloud API provider.",
    );
  try {
    return await adapter.invoke<T>(command, { request });
  } catch (error) {
    throw toRuntimeError(error);
  }
}
export const prepareHostedTextTask = (request: HostedTaskPrepare) =>
  invoke<HostedTaskReview>("hosted_text_prepare", request);
export const prepareHostedPublicWebTask = (request: HostedPublicWebTaskPrepare) =>
  invoke<HostedTaskReview>("hosted_task_prepare_public_web", request);
export const cancelHostedTextReview = (request: HostedTaskReviewTarget) =>
  invoke<HostedTaskControlResult>("hosted_text_review_cancel", request);
export const admitHostedTextTask = (request: HostedTaskCommit) =>
  invoke<HostedTaskControlResult>("hosted_text_admit", request);
export const refreshHostedTextTask = (request: HostedTaskTarget) =>
  invoke<HostedTaskControlResult>("hosted_text_refresh", request);
export const stopHostedTextTask = (request: HostedTaskTarget) =>
  invoke<HostedTaskControlResult>("hosted_text_stop", request);
export const listHostedProviders = (request: HostedProviderScope) =>
  invoke<HostedProviderConnection[]>("hosted_provider_list", request);
/** Key bytes enter an OS-native masked dialog; IPC has no secret parameter. */
export const enrollHostedProvider = (request: HostedProviderEnroll) =>
  invoke<HostedProviderConnection>("hosted_provider_enroll", request);
export const revokeHostedProvider = (request: HostedProviderRevoke) =>
  invoke<HostedProviderConnection>("hosted_provider_revoke", request);

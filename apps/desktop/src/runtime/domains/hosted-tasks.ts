import type {
  HostedProviderConnection,
  HostedProviderEnroll,
  HostedProviderRevoke,
  HostedProviderScope,
  HostedTaskCommit,
  HostedTaskControlResult,
  HostedTaskPrepare,
  HostedPublicWebTaskPrepare,
  HostedCodingTaskPrepare,
  HostedTaskReview,
  HostedTaskReviewTarget,
  HostedTaskTarget,
} from "@mivlet/protocol";
import { invokeRequiredNative } from "../required-native";

const invoke = <T>(command: string, request: object): Promise<T> =>
  invokeRequiredNative<T>(
    command,
    { request },
    "Cloud tasks require the installed desktop app and a separately connected cloud API provider.",
  );
export const prepareHostedTextTask = (request: HostedTaskPrepare) =>
  invoke<HostedTaskReview>("hosted_text_prepare", request);
export const prepareHostedPublicWebTask = (
  request: HostedPublicWebTaskPrepare,
) => invoke<HostedTaskReview>("hosted_task_prepare_public_web", request);
export const prepareHostedCodingTask = (request: HostedCodingTaskPrepare) =>
  invoke<HostedTaskReview>("hosted_task_prepare_coding", request);
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

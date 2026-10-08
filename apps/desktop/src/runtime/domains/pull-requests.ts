import type {
  LocalComputerEpochRequest,
  PullRequestLocalState,
  PullRequestRequest,
} from "@mivlet/protocol";
import { hasTauriRuntime, invokeNative, listen } from "../bridge";
export const listenPullRequestWorkUpdates = (
  onUpdate: (workspaceId: string) => void,
) =>
  hasTauriRuntime()
    ? listen<{ workspaceId: string }>("mivlet:pr-work-updated", (event) => {
        if (typeof event.payload?.workspaceId === "string")
          onUpdate(event.payload.workspaceId);
      })
    : Promise.resolve(null);
export const readPullRequest = <T>(
  target: LocalComputerEpochRequest,
  request: PullRequestRequest,
) => invokeNative<T>("coding_pr_read", { ...target, request });
export const savePullRequestState = (
  target: LocalComputerEpochRequest,
  request: PullRequestRequest,
) =>
  invokeNative<PullRequestLocalState>("coding_pr_local", {
    ...target,
    request,
  });
export const setPullRequestWatch = (
  target: LocalComputerEpochRequest,
  request: PullRequestRequest,
) =>
  invokeNative<Pick<PullRequestLocalState, "watch">>("coding_pr_watch", {
    ...target,
    request,
  });

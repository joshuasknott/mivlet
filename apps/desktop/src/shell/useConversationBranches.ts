import {
  useState,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { HydratedConversation } from "../lib/conversation-runtime";
import type { WorkspaceExecution } from "../lib/workspace-execution";
import type { ShellRuntime } from "../hooks/shell-runtime/types";
import { selectRuntimeConversationBranch } from "../runtime/domains/conversations";
import {
  branchActionBlockReason,
  branchHasMissingAncestor,
  branchInputMessageId,
} from "../lib/conversation-branches";

/** Branch changes retain canonical history, live Work checks and the shared submission guard. */
export function useConversationBranches({
  conversationId,
  history,
  service,
  runtime,
  responderId,
  discussion,
  submission,
  setPending,
  setError,
}: {
  conversationId: string;
  history?: HydratedConversation | null;
  service: WorkspaceExecution;
  runtime: Pick<ShellRuntime, "flushSnapshot">;
  responderId?: string;
  discussion: boolean;
  submission: RefObject<boolean>;
  setPending: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string>>;
}) {
  const [branchSelectionPending, setBranchSelectionPending] = useState(false);
  const selecting = useRef(false);
  const selectBranch = async (headId?: string) => {
    if (selecting.current || submission.current) return;
    const blockReason = branchActionBlockReason(
      service
        .getSnapshot()
        .data.work.filter((item) => item.conversationId === conversationId),
    );
    if (blockReason) {
      setError(blockReason);
      return;
    }
    selecting.current = true;
    setBranchSelectionPending(true);
    try {
      await selectRuntimeConversationBranch(
        conversationId,
        headId,
        history
          ? {
              headId:
                history.thread.messageHead.selectedHeadId ??
                history.thread.messageHead.lastMessageId,
              lastSequence: history.thread.messageHead.lastSequence,
            }
          : undefined,
      );
      await service.loadHistory(conversationId, true);
      let refreshed = service.getSnapshot().histories[conversationId];
      const selectedHead =
        headId ??
        refreshed?.thread.messageHead.selectedHeadId ??
        refreshed?.thread.messageHead.lastMessageId;
      while (
        refreshed &&
        branchHasMissingAncestor(refreshed.messages, selectedHead) &&
        refreshed.hasOlderMessages
      ) {
        if (!(await service.loadOlderHistory(conversationId))) break;
        refreshed = service.getSnapshot().histories[conversationId];
      }
    } finally {
      selecting.current = false;
      setBranchSelectionPending(false);
    }
  };

  /** Execute a branch submitted through assistant-ui's edit composer. The
   * normal Mivlet composer remains available for review-first edits; once the
   * assistant-ui editor sends, this callback uses the same workspace/provider
   * service and durable parent anchor without replaying prior tool effects. */
  const submitConversationBranch = async (
    messageId: string,
    text: string,
    intent: "edit" | "retry",
  ) => {
    const anchor = branchInputMessageId(history?.messages ?? [], messageId);
    if (!anchor || !text.trim()) {
      setError(
        "This conversation branch is no longer available. Reload and try again.",
      );
      return;
    }
    if (!responderId || submission.current) return;
    const blockReason = branchActionBlockReason(
      service
        .getSnapshot()
        .data.work.filter((item) => item.conversationId === conversationId),
    );
    if (blockReason) {
      setError(blockReason);
      return;
    }
    submission.current = true;
    setPending(true);
    setError("");
    try {
      await runtime.flushSnapshot();
      await service.refresh();
      await service.submit(
        conversationId,
        responderId,
        text.trim(),
        discussion,
        [],
        undefined,
        anchor,
      );
      await service.loadHistory(conversationId, true);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : `Could not ${intent === "retry" ? "regenerate" : "edit"} this message.`,
      );
    } finally {
      submission.current = false;
      setPending(false);
    }
  };

  return { selectBranch, submitConversationBranch, branchSelectionPending };
}

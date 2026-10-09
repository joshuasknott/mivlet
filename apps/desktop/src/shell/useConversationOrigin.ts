import { useEffect, useRef, useState, type RefObject } from "react";
import type { CollaborationWorkItem } from "@mivlet/protocol";
import type { HydratedConversation } from "../lib/conversation-runtime";
import { branchHasMissingAncestor } from "../lib/conversation-branches";
import { selectRuntimeConversationBranch } from "../runtime/domains/conversations";
import {
  activeWork,
  type WorkspaceExecution,
} from "../lib/workspace-execution";
import type { ConversationOriginNavigation } from "./useWorkspaceNavigation";

type OriginContentRoot = HTMLElement | null;

interface UseConversationOriginOptions {
  origin: ConversationOriginNavigation | null;
  roomId: string;
  active: boolean;
  history: HydratedConversation | null | undefined;
  service: WorkspaceExecution;
  work: readonly CollaborationWorkItem[];
  contentRef: RefObject<OriginContentRoot>;
  clearOrigin?: () => void;
  onNotice: (message: string) => void;
}

interface ConversationOriginState {
  pending: boolean;
}

const BLOCKED_ORIGIN_STATUSES = new Set([
  "blocked",
  "awaiting-user",
  "interrupted",
]);

function hasUncertainWork(work: readonly CollaborationWorkItem[]) {
  return work.some(
    (item) =>
      activeWork(item) ||
      BLOCKED_ORIGIN_STATUSES.has(String(item.status)),
  );
}

function sourceElement(
  root: OriginContentRoot,
  messageId: string,
  sourceRevisionId?: string,
) {
  if (!root) return null;
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>("[data-conversation-message-id]"),
  );
  const exact = candidates.find(
    (element) =>
      element.dataset.conversationMessageId === messageId &&
      (!sourceRevisionId ||
        element.dataset.conversationRevisionId === sourceRevisionId),
  );
  return (
    exact ??
    candidates.find(
      (element) => element.dataset.conversationMessageId === messageId,
    ) ??
    null
  );
}

/**
 * Consumes a saved-output deep link only after the canonical conversation has
 * been reloaded. Branch selection is guarded by the native expected-head and
 * sequence CAS; this hook never submits work or replays a tool action.
 */
export function useConversationOrigin({
  origin,
  roomId,
  active,
  history,
  service,
  work,
  contentRef,
  clearOrigin,
  onNotice,
}: UseConversationOriginOptions): ConversationOriginState {
  const [pending, setPending] = useState(false);
  const handled = useRef<string | null>(null);
  const originRef = useRef(origin);
  originRef.current = origin;
  const historyRef = useRef(history);
  historyRef.current = history;
  const workRef = useRef(work);
  workRef.current = work;
  const originKey = origin ? JSON.stringify(origin) : null;

  useEffect(() => {
    if (!originRef.current) {
      handled.current = null;
      return;
    }
    if (
      !active ||
      originRef.current.conversationId !== roomId ||
      handled.current === JSON.stringify(originRef.current)
    )
      return;
    let disposed = false;
    const currentOrigin = originRef.current;
    if (!currentOrigin) return;
    const key = JSON.stringify(currentOrigin);
    handled.current = key;
    setPending(true);
    let consumed = false;

    const consume = async () => {
      try {
        const currentWork = service
          .getSnapshot()
          .data.work.filter((item) => item.conversationId === roomId);
        if (
          hasUncertainWork(
            currentWork.length ? currentWork : workRef.current,
          )
        ) {
          onNotice(
            "This conversation has active or uncertain work. Stop or review it before opening another branch.",
          );
          return;
        }

        // Restore a bounded newest page first. Older source messages are
        // loaded through the durable sequence cursor below, so reopening an
        // output does not turn a deep link into an unbounded transcript read.
        await service.loadHistory(roomId);
        if (disposed) return;
        let latest =
          service.getSnapshot().histories[roomId] ?? historyRef.current;
        if (!latest) throw new Error("This conversation history is unavailable.");

        if (currentOrigin.branchId) {
          const selectedHead =
            latest.thread.messageHead.selectedHeadId ??
            latest.thread.messageHead.lastMessageId;
          if (selectedHead !== currentOrigin.branchId) {
            await selectRuntimeConversationBranch(
              roomId,
              currentOrigin.branchId,
              {
                headId: selectedHead,
                lastSequence: latest.thread.messageHead.lastSequence,
              },
            );
            await service.loadHistory(roomId, true);
            if (disposed) return;
            latest = service.getSnapshot().histories[roomId] ?? latest;
          }
        }

        if (currentOrigin.branchId) {
          while (
            branchHasMissingAncestor(latest.messages, currentOrigin.branchId) &&
            latest.hasOlderMessages
          ) {
            const loaded = await service.loadOlderHistory(roomId);
            if (!loaded) break;
            latest = service.getSnapshot().histories[roomId] ?? latest;
          }
        }

        if (currentOrigin.messageId) {
          // Walk older bounded pages until the exact durable source is present.
          // This keeps origin navigation correct after restart while preserving
          // the selected branch and never substituting a nearby message.
          while (
            !latest.messages.some(
              (entry) => entry.message.id === currentOrigin.messageId,
            ) &&
            latest.hasOlderMessages
          ) {
            const loaded = await service.loadOlderHistory(roomId);
            if (!loaded) break;
            latest = service.getSnapshot().histories[roomId] ?? latest;
          }
          const message = latest.messages.find(
            (entry) => entry.message.id === currentOrigin.messageId,
          );
          if (!message) {
            onNotice(
              "The originating message is no longer present on this conversation branch.",
            );
            return;
          }
          if (
            currentOrigin.sourceRevisionId &&
            message.message.currentRevisionId !== currentOrigin.sourceRevisionId
          ) {
            onNotice(
              "The originating message has since been revised; showing its current saved revision.",
            );
          }
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => resolve());
            });
          });
          if (disposed) return;
          const element = sourceElement(
            contentRef.current,
            currentOrigin.messageId,
            currentOrigin.sourceRevisionId,
          );
          if (!element) {
            onNotice("The originating message could not be focused in this view.");
            return;
          }
          element.tabIndex = -1;
          element.focus({ preventScroll: true });
          element.scrollIntoView?.({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        }
        consumed = true;
      } catch (error) {
        handled.current = null;
        if (!disposed)
          onNotice(
            error instanceof Error
              ? error.message
              : "Could not open the originating conversation branch.",
          );
      } finally {
        if (!disposed) {
          setPending(false);
          if (consumed) clearOrigin?.();
        }
      }
    };
    void consume();
    return () => {
      disposed = true;
    };
  }, [
    active,
    clearOrigin,
    contentRef,
    onNotice,
    originKey,
    roomId,
    service,
  ]);

  return { pending };
}

import { useMemo, type ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessage,
} from "@assistant-ui/react";
import type { ConversationMessageView } from "../../lib/conversation-runtime";

interface Props {
  threadId: string;
  messages: readonly ConversationMessageView[];
  selectedHeadId?: string;
  isRunning?: boolean;
  children: ReactNode;
  onNew?: (text: string) => Promise<void> | void;
  onEdit?: (messageId: string, text: string) => Promise<void> | void;
  onReload?: (messageId: string) => Promise<void> | void;
  onCancel?: () => Promise<void> | void;
  onBranchChange?: (headId: string | null) => Promise<void> | void;
}

function textFromAppend(message: AppendMessage) {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function toAssistantMessage(view: ConversationMessageView): ThreadMessage {
  const { message, currentRevision } = view;
  const content = currentRevision.state === "redacted"
    ? "[Content unavailable]"
    : currentRevision.content;
  return {
      id: message.id,
      role: message.kind === "user" ? "user" : "assistant",
      content: [{ type: "text", text: content }],
      createdAt: new Date(message.createdAt),
      ...(message.kind === "user" ? {} : {
        status: { type: "complete" as const, reason: "stop" as const },
        metadata: {
          unstable_state: {},
          unstable_annotations: [],
          unstable_data: [],
          steps: [],
          custom: {},
        },
      }),
    } as ThreadMessage;
}

/** Canonical branch-aware repository rows consumed by assistant-ui. */
export function assistantStoreMessages(
  views: readonly ConversationMessageView[],
) {
  const ids = new Set(views.map((view) => String(view.message.id)));
  return views.map((view) => ({
    message: toAssistantMessage(view),
    // A paginated snapshot may begin in the middle of a durable branch. Cut
    // only that missing edge at the assistant-ui boundary so it keeps the
    // loaded page readable; native persistence retains the real parent and a
    // later history page can restore the complete relation.
    parentId: (() => {
      const parent =
        view.message.parentMessageId === undefined ? view.message.previousMessageId : view.message.parentMessageId;
      return parent && ids.has(String(parent)) ? String(parent) : null;
    })(),
  }));
}

/**
 * Bridges Mivlet's encrypted conversation transport into assistant-ui's
 * external-store runtime. The provider is deliberately a wrapper around the
 * existing Feed so assistant-ui never becomes a second message database or
 * execution engine.
 */
export function AssistantConversationRuntime({ children, ...props }: Props) {
  const messages = useMemo(
    () => assistantStoreMessages(props.messages),
    [props.messages],
  );
  const messageRepository = useMemo(
    () => ({ messages, headId: props.selectedHeadId }),
    [messages, props.selectedHeadId],
  );
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    isRunning: props.isRunning,
    messageRepository,
    // Branch selection remains host-owned. The runtime needs this capability
    // to expose its picker; the selected head callback reloads the canonical
    // repository and replaces this snapshot.
    setMessages: () => undefined,
    onNew: async (message: AppendMessage) => {
      const text = textFromAppend(message).trim();
      if (text && props.onNew) await props.onNew(text);
    },
    onEdit: async (message: AppendMessage) => {
      const text = textFromAppend(message).trim();
      // assistant-ui deliberately supplies sourceId for edits and parentId for
      // the branch location. The source is the durable Mivlet message being
      // edited; using parentId here would edit the preceding message instead.
      if (!text || !props.onEdit || !message.sourceId) return;
      await props.onEdit(String(message.sourceId), text);
    },
    onReload: async (messageId: string | null) => {
      if (props.onReload && messageId) await props.onReload(messageId);
    },
    onCancel: async () => {
      if (props.onCancel) await props.onCancel();
    },
    unstable_onBranchChange: async ({ headId }: { headId: string | null }) => {
      if (props.onBranchChange) await props.onBranchChange(headId);
    },
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="assistant-ui-thread-root">
        {children}
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

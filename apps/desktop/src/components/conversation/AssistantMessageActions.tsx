import {
  ActionBarPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CopySimple } from "@phosphor-icons/react/dist/csr/CopySimple";
import { PencilSimple } from "@phosphor-icons/react/dist/csr/PencilSimple";
import "./assistant-message-actions.css";

function MessageActions() {
  const editing = useAuiState((state) => state.composer.isEditing);
  const user = useAuiState((state) => state.message.role === "user");
  const copied = useAuiState((state) => state.message.isCopied);
  const copyLabel = user ? "Copy message" : "Copy response";
  const copyTooltip = copied ? "Copied" : copyLabel;
  return (
    <MessagePrimitive.Root className="assistant-message-tools">
      {editing && user ? (
        <ComposerPrimitive.Root className="message-edit-form">
          <ComposerPrimitive.Input
            aria-label="Edit earlier message"
            autoFocus
            submitMode="ctrlEnter"
            addAttachmentOnPaste={false}
            unstable_focusOnRunStart={false}
            unstable_focusOnScrollToBottom={false}
            unstable_focusOnThreadSwitched={false}
          />
          <p>Creates an alternative conversation. Completed actions remain in the original history and cannot be undone by editing.</p>
          <div>
            <ComposerPrimitive.Cancel>Cancel edit</ComposerPrimitive.Cancel>
            <ComposerPrimitive.Send>Send edited message</ComposerPrimitive.Send>
          </div>
        </ComposerPrimitive.Root>
      ) : (
        <ActionBarPrimitive.Root className="assistant-message-actions" hideWhenRunning autohide="never">
          <ActionBarPrimitive.Copy className="assistant-message-action" aria-label={copyLabel} title={copyTooltip}>
            <CopySimple size={16} aria-hidden="true" />
            <span className="sr-only">{copyLabel}</span>
            <span className="assistant-message-action__tooltip" role="tooltip" aria-hidden="true">{copyTooltip}</span>
          </ActionBarPrimitive.Copy>
          {user ? (
            <ActionBarPrimitive.Edit className="assistant-message-action" aria-label="Edit message" title="Edit message">
              <PencilSimple size={16} aria-hidden="true" />
              <span className="sr-only">Edit message</span>
              <span className="assistant-message-action__tooltip" role="tooltip" aria-hidden="true">Edit message</span>
            </ActionBarPrimitive.Edit>
          ) : (
            <ActionBarPrimitive.Reload className="assistant-message-action" aria-label="Regenerate response" title="Create another answer; previous actions remain in history">
              <ArrowClockwise size={16} aria-hidden="true" />
              <span className="sr-only">Regenerate response</span>
              <span className="assistant-message-action__tooltip" role="tooltip" aria-hidden="true">Regenerate response</span>
            </ActionBarPrimitive.Reload>
          )}
        </ActionBarPrimitive.Root>
      )}
    </MessagePrimitive.Root>
  );
}

// Stable component identity preserves the edit draft when the external store
// refreshes a saved message or another agent contributes to the conversation.
const components = { Message: MessageActions };

export function AssistantMessageActions({ messageId }: { messageId: string }) {
  return <ThreadPrimitive.Unstable_MessageById messageId={messageId} components={components} />;
}

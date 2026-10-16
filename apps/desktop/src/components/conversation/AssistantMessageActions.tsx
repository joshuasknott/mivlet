import {
  ActionBarPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import "./assistant-message-actions.css";

function MessageActions() {
  const editing = useAuiState((state) => state.composer.isEditing);
  const user = useAuiState((state) => state.message.role === "user");
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
          <ActionBarPrimitive.Copy aria-label={user ? "Copy message" : "Copy response"}>Copy</ActionBarPrimitive.Copy>
          {user ? (
            <ActionBarPrimitive.Edit>Edit message</ActionBarPrimitive.Edit>
          ) : (
            <ActionBarPrimitive.Reload aria-label="Regenerate response" title="Create another answer; previous actions remain in history">Regenerate</ActionBarPrimitive.Reload>
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

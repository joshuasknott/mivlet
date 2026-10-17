/** Keep the conversation's scope notice independent of the deferred list/editor. */
export function SideChatContextNotice({ compact = false }: { compact?: boolean }) {
  return (
    <p className="side-chat-notice" role="note">
      <strong>Side Chats are separate conversations.</strong>{" "}
      {compact
        ? "This chat keeps its own transcript."
        : "Each keeps its own transcript and never inherits another chat's history. Only the Agent's durable instructions and conclusions you explicitly promote to Memory carry over."}
    </p>
  );
}

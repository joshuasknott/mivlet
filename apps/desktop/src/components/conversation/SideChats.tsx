import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ConversationRoom } from "@fable/protocol";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import {
  partitionSideChats,
  type SideChatOwner,
} from "../../lib/conversation-service";

/**
 * Side Chats are durable but separate conversations. This notice is reused by
 * the list and by a Side Chat's own header so the boundary is never implied.
 */
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

export function SideChatEditor({
  heading,
  ownerLabel,
  initialTitle = "",
  submitLabel,
  onSave,
  onClose,
}: {
  heading: string;
  ownerLabel: string;
  initialTitle?: string;
  submitLabel: string;
  onSave: (title: string) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const headingId = useId();
  useModalFocusTrap({
    active: true,
    containerRef: panel,
    onClose: () => {
      if (!pending) onClose();
    },
  });
  const trimmed = title.trim();
  return (
    <div className="side-chat-dialog-backdrop">
      <div
        className="side-chat-dialog"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <header>
          <h2 id={headingId}>{heading}</h2>
          <button
            type="button"
            disabled={pending}
            aria-label="Close Side Chat editor"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!trimmed) {
              setError("Give this Side Chat a name.");
              return;
            }
            setPending(true);
            setError("");
            void onSave(trimmed)
              .then(onClose)
              .catch((cause) =>
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Could not save this Side Chat.",
                ),
              )
              .finally(() => setPending(false));
          }}
        >
          <p className="side-chat-dialog__owner">{ownerLabel}</p>
          <label>
            Side Chat name
            <input
              autoFocus
              value={title}
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="What is this separate conversation about?"
            />
          </label>
          <SideChatContextNotice />
          {error ? <p role="alert">{error}</p> : null}
          <footer>
            <button type="button" disabled={pending} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={pending || !trimmed}>
              {pending ? "Saving…" : submitLabel}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

export interface SideChatListProps {
  chats: readonly ConversationRoom[];
  owner: SideChatOwner;
  ownerName: string;
  activeId?: string;
  busy?: boolean;
  onOpen: (room: ConversationRoom) => void;
  /** Creates a new Side Chat with the given name. */
  onCreate: (title: string) => Promise<void>;
  onRename: (room: ConversationRoom, title: string) => Promise<void>;
  onArchive: (room: ConversationRoom, archived: boolean) => Promise<void>;
  onDelete: (room: ConversationRoom) => Promise<void>;
}

/**
 * Reusable Side Chat list and editor. P8 places it in navigation or a side
 * panel; it never owns layout, routing or provider authority.
 */
export function SideChatList({
  ...props
}: SideChatListProps) {
  return <OwnedSideChatList key={`${props.owner.kind}:${props.owner.id}`} {...props} />;
}

function OwnedSideChatList({
  chats,
  owner,
  ownerName,
  activeId,
  busy = false,
  onOpen,
  onCreate,
  onRename,
  onArchive,
  onDelete,
}: SideChatListProps) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"active" | "archived">("active");
  const [editor, setEditor] = useState<
    { mode: "create" } | { mode: "rename"; room: ConversationRoom } | null
  >(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const groups = useMemo(
    () => partitionSideChats(chats, owner, query),
    [chats, owner, query],
  );
  const visible = view === "active" ? groups.active : groups.archived;
  useEffect(() => {
    setConfirmingId(null);
  }, [view, query]);
  const run = async (id: string, action: () => Promise<void>) => {
    setWorkingId(id);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The Side Chat was not saved.",
      );
    } finally {
      setWorkingId(null);
    }
  };
  const label = owner.kind === "project" ? "Project Side Chat" : "Agent Side Chat";
  return (
    <section className="side-chats" aria-label={`${ownerName} Side Chats`}>
      <header className="side-chats__header">
        <div>
          <h3>Side Chats</h3>
          <small>
            {label} · {ownerName}
          </small>
        </div>
        <button
          type="button"
          className="side-chats__new"
          disabled={busy}
          onClick={() => setEditor({ mode: "create" })}
        >
          New Side Chat
        </button>
      </header>
      <SideChatContextNotice />
      <input
        className="side-chats__search"
        type="search"
        aria-label={`Search ${ownerName} Side Chats`}
        placeholder="Search Side Chats…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="side-chats__views" role="tablist" aria-label="Side Chat status">
        <button
          type="button"
          role="tab"
          aria-selected={view === "active"}
          onClick={() => setView("active")}
        >
          Active ({groups.active.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "archived"}
          onClick={() => setView("archived")}
        >
          Archived ({groups.archived.length})
        </button>
      </div>
      {visible.length ? (
        <ul className="side-chats__list">
          {visible.map((room) => {
            const working = workingId === room.id || busy;
            const confirming = confirmingId === room.id;
            return (
              <li key={room.id} className="side-chats__row">
                <button
                  type="button"
                  className="side-chats__open"
                  aria-current={room.id === activeId ? "page" : undefined}
                  disabled={busy}
                  onClick={() => {
                    setConfirmingId(null);
                    onOpen(room);
                  }}
                >
                  <span>{room.title}</span>
                  <small>
                    {room.archived ? "Archived · " : ""}
                    {room.participants.map((member) => member.name).join(", ")}
                  </small>
                </button>
                <div className="side-chats__actions">
                  {confirming ? (
                    <>
                      <button
                        type="button"
                        className="side-chats__danger"
                        disabled={working}
                        onClick={() =>
                          void run(room.id, () => onDelete(room))
                        }
                      >
                        Delete Side Chat
                      </button>
                      <button
                        type="button"
                        disabled={working}
                        onClick={() => setConfirmingId(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        aria-label={`Rename ${room.title}`}
                        disabled={working}
                        onClick={() => setEditor({ mode: "rename", room })}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        aria-label={`${room.archived ? "Restore" : "Archive"} ${room.title}`}
                        disabled={working}
                        onClick={() =>
                          void run(room.id, () =>
                            onArchive(room, !room.archived),
                          )
                        }
                      >
                        {room.archived ? "Restore" : "Archive"}
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${room.title}`}
                        disabled={working}
                        onClick={() => setConfirmingId(room.id)}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="side-chats__empty">
          {query.trim()
            ? "No Side Chats match this search."
            : view === "archived"
              ? "No archived Side Chats."
              : `No Side Chats yet. Start one when this ${owner.kind === "project" ? "project" : "Agent"} needs a separate line of work.`}
        </p>
      )}
      {error ? (
        <p className="side-chats__error" role="alert">
          {error}
        </p>
      ) : null}
      {editor ? (
        <SideChatEditor
          heading={editor.mode === "create" ? "New Side Chat" : "Rename Side Chat"}
          ownerLabel={`${label} · ${ownerName}`}
          initialTitle={editor.mode === "rename" ? editor.room.title : ""}
          submitLabel={editor.mode === "create" ? "Create Side Chat" : "Save name"}
          onSave={
            editor.mode === "create"
              ? (title) => onCreate(title)
              : (title) => onRename(editor.room, title)
          }
          onClose={() => setEditor(null)}
        />
      ) : null}
    </section>
  );
}

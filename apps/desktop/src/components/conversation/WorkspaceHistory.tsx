import { useRef, useState, type ReactNode } from "react";
import { X } from "@phosphor-icons/react/dist/csr/X";
import type { CollaborationWorkItem, ConversationRoom } from "@fable/protocol";
import {
  activeWork,
  type WorkspaceExecution,
} from "../../lib/workspace-execution";
import { WorkItems } from "../projects/WorkItems";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";

export function WorkspaceHistory({
  rooms,
  work,
  activeId,
  indicators,
  service,
  onOpen,
  onClose,
  projectDetails,
}: {
  rooms: ConversationRoom[];
  work: CollaborationWorkItem[];
  activeId?: string;
  indicators: Record<string, string>;
  service: WorkspaceExecution;
  onOpen: (id: string, newTab?: boolean) => void;
  onClose: () => void;
  projectDetails?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [details, setDetails] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const compact = useMediaQuery("(max-width: 850px)");
  useModalFocusTrap({ active: compact, containerRef: panel, onClose });
  const timestamps = new Map(rooms.map((room) => [room.id, room.updatedAt]));
  for (const item of work)
    if (item.updatedAt > (timestamps.get(item.conversationId) ?? ""))
      timestamps.set(item.conversationId, item.updatedAt);
  const history = rooms
    .filter((room) =>
      room.title.toLowerCase().includes(query.trim().toLowerCase()),
    )
    .sort((a, b) =>
      (timestamps.get(b.id) ?? "").localeCompare(timestamps.get(a.id) ?? ""),
    );
  const running = work.filter(
    (item) =>
      activeWork(item) || ["awaiting-user", "blocked", "failed"].includes(item.status),
  );
  return (
    <aside ref={panel} className="workspace-history" role={compact ? "dialog" : undefined} aria-modal={compact || undefined} aria-label="Conversation history">
      <header>
        <div role="tablist" aria-label="Conversation information">
          <button
            role="tab"
            type="button"
            aria-selected={!details}
            onClick={() => setDetails(false)}
          >
            History
          </button>
          <button
            role="tab"
            type="button"
            aria-selected={details}
            onClick={() => setDetails(true)}
          >
            Details
          </button>
        </div>
        <button type="button" aria-label="Close history" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      {details ? (
        <div className="workspace-history__details">
          {projectDetails ?? (
            <WorkItems
              work={work.filter((item) => item.conversationId === activeId)}
              service={service}
              onOpen={onOpen}
            />
          )}
        </div>
      ) : (
        <>
          {running.length ? (
            <div
              className="workspace-history__running"
              aria-label="Work needing attention"
            >
              {running.map((item) => (
                <div key={item.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(item.conversationId)}
                  >
                    <strong>{item.agentName}</strong>
                    <small>{item.status.replaceAll("-", " ")}</small>
                  </button>
                  {activeWork(item) ? (
                    <button
                      type="button"
                      aria-label={`Stop ${item.agentName}'s assignment`}
                      onClick={() =>
                        void service
                          .stop(item.id)
                          .catch((error) => service.report(error))
                      }
                    >
                      Stop
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          <input
            className="workspace-history__search"
            type="search"
            aria-label="Search conversation history"
            placeholder="Search conversation titles…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="workspace-history__list">
            {history.map((room) => {
              const date = timestamps.get(room.id) ?? room.createdAt;
              return (
                <button
                  type="button"
                  key={room.id}
                  className="workspace-history__row"
                  aria-current={room.id === activeId ? "page" : undefined}
                  data-conversation-room={room.id}
                  onDragStart={(event) => event.preventDefault()}
                  onClick={(event) =>
                    onOpen(room.id, event.ctrlKey || event.metaKey)
                  }
                  title={`${room.title} · Drag to the tab bar to open a tab`}
                >
                  <span>{room.title}</span>
                  <time dateTime={date}>
                    {new Date(date).toLocaleString(undefined, {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                  {indicators[room.id] ? (
                    <small aria-label={indicators[room.id]}>
                      {["Working", "Unread"].includes(indicators[room.id])
                        ? "•"
                        : "!"}
                    </small>
                  ) : null}
                </button>
              );
            })}
            {!history.length ? <p>No conversations found.</p> : null}
          </div>
        </>
      )}
    </aside>
  );
}

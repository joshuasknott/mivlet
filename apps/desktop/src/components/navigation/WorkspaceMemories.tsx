import { useEffect, useState } from "react";
import type { ConversationRoom, MemoryRecord } from "@mivlet/protocol";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import "./workspace-memories.css";

type MemoryRuntime = Pick<
  ShellRuntime,
  | "managedMemoryRecords"
  | "memoryDisabled"
  | "addChatMemory"
  | "approveMemory"
  | "refreshMemories"
  | "correctMemory"
  | "forgetMemory"
  | "toggleMemoryRecordDisabled"
>;

/** Match the context inheritance contract; never expose a sibling chat here. */
export function memoryGroup(
  record: MemoryRecord,
  room: ConversationRoom,
): string | null {
  if (
    record.forgottenAt ||
    record.approvalState === "rejected" ||
    (record.workspaceId && record.workspaceId !== room.workspaceId)
  )
    return null;
  const scope = record.scope;
  if (scope?.level === "thread")
    return scope.threadId === room.id ? "This chat" : null;
  if (room.projectId)
    return scope?.level === "project" && scope.projectId === room.projectId
      ? "From this project"
      : null;
  if (!scope || scope.level === "global") return "Account-wide";
  const owner =
    room.chat?.ownerKind === "agent"
      ? room.chat.ownerId
      : (room.facilitatorId ??
        (room.participants.length === 1
          ? room.participants[0].agentId
          : undefined));
  return scope.level === "agent" && owner && scope.agentId === owner
    ? "From this agent"
    : null;
}

export function WorkspaceMemories({
  room,
  runtime,
}: {
  room?: ConversationRoom;
  runtime: MemoryRuntime;
}) {
  const [query, setQuery] = useState("");
  const refresh = runtime.refreshMemories;
  useEffect(() => { void refresh(); }, [refresh]);
  const [editor, setEditor] = useState<{
    record?: MemoryRecord;
    title: string;
    value: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const act = async (operation: () => Promise<void>, message: string) => {
    if (pending) return;
    setPending(true);
    setError("");
    setStatus("");
    try {
      await operation();
      setStatus(message);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Memory could not be updated.",
      );
    } finally {
      setPending(false);
    }
  };
  const records = room
    ? runtime.managedMemoryRecords.flatMap((record) => {
        const group = memoryGroup(record, room);
        return group &&
          `${record.title} ${record.value}`
            .toLowerCase()
            .includes(query.trim().toLowerCase())
          ? [{ record, group }]
          : [];
      })
    : [];
  const suggested = records.filter(
    ({ record }) => record.approvalState === "suggested",
  );
  const saved = records.filter(
    ({ record }) => record.approved && record.approvalState !== "suggested",
  );
  return (
    <section className="workspace-memories" aria-label="Memories">
      <header className="workspace-library__heading">
        <div>
          <h2>Memories</h2>
          <p>{room?.title ?? "Choose a conversation"}</p>
        </div>
        <button
          type="button"
          aria-label="Add memory"
          disabled={!room || pending}
          onClick={() => {
            setEditor({ title: "", value: "" });
            setError("");
          }}
        >
          <Plus size={20} aria-hidden="true" />
          Add
        </button>
      </header>
      {runtime.memoryDisabled && (
        <p className="workspace-memories__notice">
          Memory is paused in Settings. Saved memories won’t be used until it is
          enabled.
        </p>
      )}
      {room && (
        <label className="workspace-library__search">
          <MagnifyingGlass size={17} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search memories"
            placeholder="Search memories"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}
      {editor && room && (
        <form
          className="workspace-memories__editor"
          onSubmit={(event) => {
            event.preventDefault();
            void act(
              async () => {
                if (editor.record)
                  await runtime.correctMemory(
                    editor.record.id,
                    editor.title.trim(),
                    editor.value.trim(),
                    editor.record.updatedAt,
                  );
                else
                  await runtime.addChatMemory(
                    room.id,
                    editor.title.trim(),
                    editor.value.trim(),
                  );
                setEditor(null);
              },
              editor.record ? "Memory updated." : "Memory saved to this chat.",
            );
          }}
        >
          <p>
            {editor.record
              ? `Editing · ${memoryGroup(editor.record, room)}`
              : "New memory · This chat"}
          </p>
          <label>
            Title
            <input
              autoFocus
              required
              maxLength={120}
              value={editor.title}
              disabled={pending}
              onChange={(event) =>
                setEditor({ ...editor, title: event.target.value })
              }
            />
          </label>
          <label>
            Memory
            <textarea
              required
              maxLength={2000}
              rows={4}
              value={editor.value}
              disabled={pending}
              onChange={(event) =>
                setEditor({ ...editor, value: event.target.value })
              }
            />
          </label>
          <div>
            <button
              type="submit"
              disabled={pending || !editor.title.trim() || !editor.value.trim()}
            >
              {pending ? "Saving…" : "Save memory"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setEditor(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {[
        "This chat",
        "From this project",
        "From this agent",
        "Account-wide",
      ].map((group) => {
        const entries = saved.filter((entry) => entry.group === group);
        return entries.length ? (
          <section
            className="workspace-memories__group"
            key={group}
            aria-label={group}
          >
            <h3>{group}</h3>
            {entries.map(({ record }) => (
              <article className="workspace-memories__record" key={record.id}>
                <div className="workspace-memories__record-heading">
                  <strong>{record.title}</strong>
                  <details
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.currentTarget.open = false;
                        event.currentTarget.querySelector("summary")?.focus();
                      }
                    }}
                  >
                    <summary aria-label={`Actions for ${record.title}`}>
                      ···
                    </summary>
                    <div className="workspace-memories__actions">
                      <button
                        type="button"
                        disabled={pending}
                        onClick={(event) => {
                          event.currentTarget
                            .closest("details")
                            ?.removeAttribute("open");
                          setEditor({
                            record,
                            title: record.title,
                            value: record.value,
                          });
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          void act(
                            () => runtime.toggleMemoryRecordDisabled(record.id),
                            record.disabled
                              ? "Memory enabled."
                              : "Memory disabled.",
                          )
                        }
                      >
                        {record.disabled ? "Enable" : "Disable"}
                      </button>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          void act(
                            () => runtime.forgetMemory(record.id),
                            "Memory deleted. The original conversation is unchanged.",
                          )
                        }
                      >
                        Delete
                      </button>
                    </div>
                  </details>
                </div>
                <p>{record.value}</p>
                <small>
                  {record.source}
                  {record.disabled ? " · Disabled" : ""}
                </small>
              </article>
            ))}
          </section>
        ) : null;
      })}
      {suggested.length > 0 && (
        <section
          className="workspace-memories__group"
          aria-label="Suggested memories"
        >
          <h3>Suggested memories</h3>
          {suggested.map(({ record, group }) => (
            <article className="workspace-memories__record" key={record.id}>
              <strong>{record.title}</strong>
              <p>{record.value}</p>
              <small>
                {group} · {record.source}
              </small>
              <div className="workspace-memories__suggestion-actions">
                <button
                  disabled={pending}
                  onClick={() =>
                    void act(
                      () => runtime.approveMemory(record.id),
                      "Memory saved.",
                    )
                  }
                >
                  Save
                </button>
                <button
                  disabled={pending}
                  onClick={() =>
                    void act(
                      () => runtime.forgetMemory(record.id),
                      "Suggestion dismissed.",
                    )
                  }
                >
                  Dismiss
                </button>
              </div>
            </article>
          ))}
        </section>
      )}
      {!records.length && room && (
        <p className="right-panel__empty">
          {query.trim()
            ? "No memories match your search."
            : "No saved memories yet. Add a lasting decision, preference, or fact. Messages aren’t saved as memories automatically."}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
    </section>
  );
}

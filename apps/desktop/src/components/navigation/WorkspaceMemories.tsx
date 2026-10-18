import { useEffect, useState, type ReactNode } from "react";
import type { ConversationRoom, MemoryRecord } from "@mivlet/protocol";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import "./workspace-memories.css";
import { MemoryRecordCard } from "./MemoryRecordCard";
import { PanelPagination } from "./PanelPagination";
import { BookOpen } from "@phosphor-icons/react/dist/csr/BookOpen";
import {
  memoryGroup,
  panelMemories,
} from "./workspace-panel-data";
export { memoryGroup } from "./workspace-panel-data";

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

export function WorkspaceMemories({
  room,
  runtime,
  sourceIds = [],
  onOpenSource,
}: {
  room?: ConversationRoom;
  runtime: MemoryRuntime;
  sourceIds?: readonly string[];
  onOpenSource?: (sourceId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const refresh = runtime.refreshMemories;

  const [editor, setEditor] = useState<{
    record?: MemoryRecord;
    title: string;
    value: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [refreshing, setRefreshing] = useState(true);
  useEffect(() => {
    let current = true;
    setRefreshing(true);
    void refresh()
      .catch((failure: unknown) => {
        if (current)
          setError(
            failure instanceof Error
              ? failure.message
              : "Memory could not be loaded.",
          );
      })
      .finally(() => {
        if (current) setRefreshing(false);
      });
    return () => {
      current = false;
    };
  }, [refresh]);
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
  const records = panelMemories(runtime.managedMemoryRecords, room).filter(({ record }) =>
    (record.title + " " + record.value)
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  records.sort((a, b) =>
    (b.record.updatedAt ?? b.record.createdAt ?? "").localeCompare(
      a.record.updatedAt ?? a.record.createdAt ?? "",
    ),
  );
  const suggested = records.filter(
    ({ record }) => record.approvalState === "suggested",
  );
  const saved = records.filter(
    ({ record }) => record.approved && record.approvalState !== "suggested",
  );
  const renderRecord = ({
    record,
    group,
  }: {
    record: MemoryRecord;
    group: string;
  }) => (
    <MemoryRecordCard
      key={record.id}
      record={record}
      group={group}
      pending={pending}
      onEdit={() => {
        setEditor({ record, title: record.title, value: record.value });
        setError("");
      }}
      onToggle={() =>
        void act(
          () => runtime.toggleMemoryRecordDisabled(record.id),
          record.disabled ? "Memory enabled." : "Memory disabled.",
        )
      }
      onDelete={() =>
        void act(
          () => runtime.forgetMemory(record.id),
          record.approvalState === "suggested"
            ? "Suggestion dismissed."
            : "Memory deleted. The original conversation is unchanged.",
        )
      }
      onApprove={() =>
        void act(() => runtime.approveMemory(record.id), "Memory saved.")
      }
      onOpenSource={
        record.provenance?.sourceId &&
        sourceIds.includes(record.provenance.sourceId) &&
        onOpenSource
          ? () => onOpenSource(record.provenance!.sourceId!)
          : undefined
      }
    />
  );
  return (
    <section className="workspace-memories" aria-label="Saved memory">
      <div className="panel-collection__controls">
        <header className="workspace-library__heading">
          <div>
            <h2>Memory</h2>
            {!room && <p>Choose a conversation</p>}
          </div>
        </header>
        {runtime.memoryDisabled && (
          <p className="workspace-memories__notice">
            Memory is paused in Settings. Saved memories won’t be used until it
            is enabled.
          </p>
        )}
        <div className="workspace-library__toolbar">
          {room && (
            <label className="workspace-library__search">
              <MagnifyingGlass size={17} aria-hidden="true" />
              <input
                type="search"
                aria-label="Search memories"
                placeholder="Search memories"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
              />
            </label>
          )}
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
        </div>
      </div>
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
      <MemoryCollection
        key={"saved:" + query}
        label="This chat"
        title="Saved in this chat"
        entries={saved.filter((entry) => entry.group === "This chat")}
        pageSize={12}
        renderRecord={renderRecord}
      />
      <MemoryCollection
        key={"suggested:" + query}
        label="Suggested memories"
        title="Suggested memories"
        entries={suggested}
        pageSize={3}
        renderRecord={renderRecord}
      />
      {["From this project", "From this agent", "Account-wide"].map(
          (group) => {
            const entries = saved.filter((entry) => entry.group === group);
            return entries.length ? (
              <details
                key={group + query}
                className="workspace-memories__inherited"
                open={Boolean(query.trim())}
              >
                <summary>
                  <BookOpen size={19} aria-hidden="true" />
                  <span>
                    {group}
                    <small>Inherited memory</small>
                  </span>
                  <span className="workspace-memories__count">
                    {entries.length}
                  </span>
                </summary>
                <MemoryCollection
                  key={query}
                  label={group}
                  title={group}
                  entries={entries}
                  pageSize={8}
                  renderRecord={renderRecord}
                />
              </details>
            ) : null;
          },
        )}
      {refreshing && !records.length && <p role="status">Loading memory…</p>}
      {!records.length && room && !refreshing && !error && (
        <p className="right-panel__empty">
          {query.trim()
            ? "No memories match your search."
            : "No saved memories yet. Add a lasting decision, preference, or fact. Messages aren’t saved as memories automatically."}
        </p>
      )}
      {error && (
        <div>
          <p role="alert">{error}</p>
          <button
            type="button"
            className="workspace-panel__link"
            disabled={pending}
            onClick={() => void act(refresh, "Memory refreshed.")}
          >
            Retry memory
          </button>
        </div>
      )}
      {status && <p role="status">{status}</p>}
    </section>
  );
}

function MemoryCollection({
  label,
  title,
  entries,
  pageSize,
  renderRecord,
}: {
  label: string;
  title: string;
  entries: { record: MemoryRecord; group: string }[];
  pageSize: number;
  renderRecord: (entry: { record: MemoryRecord; group: string }) => ReactNode;
}) {
  const [page, setPage] = useState(0);
  if (!entries.length) return null;
  const current = Math.min(
    page,
    Math.max(0, Math.ceil(entries.length / pageSize) - 1),
  );
  return (
    <section className="workspace-memories__group" aria-label={label}>
      <h3>
        {title}
        <span>{entries.length}</span>
      </h3>
      {entries
        .slice(current * pageSize, (current + 1) * pageSize)
        .map(renderRecord)}
      <PanelPagination
        total={entries.length}
        page={current}
        pageSize={pageSize}
        label={label + " memory"}
        onChange={setPage}
      />
    </section>
  );
}

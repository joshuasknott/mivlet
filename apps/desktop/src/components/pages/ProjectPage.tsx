import { useEffect, useRef, useState } from "react";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { FilePlus } from "@phosphor-icons/react/dist/csr/FilePlus";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { DownloadSimple } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import type { SourceStatus, ThreadSummary } from "@fable/protocol";
import { PageHeader } from "../PageHeader";

export interface ProjectPageRecord {
  id: string;
  title: string;
  description: string;
  instructions: string;
  lifecycle: "active" | "archived";
  revision: number;
  threads: ThreadSummary[];
}

export interface ProjectKnowledgeSourceView {
  id: string;
  title: string;
  provenance: string;
  freshness: string;
  status?: SourceStatus;
  statusMessage?: string;
}

export interface ProjectKnowledgeView {
  sources: ProjectKnowledgeSourceView[];
  loading: boolean;
  error: string | null;
  refresh: () => void | Promise<unknown>;
  importFile: (file: File) => Promise<unknown>;
  search: (query: string) => Promise<ProjectKnowledgeSourceView[]>;
}

export interface ProjectMemoryRecordView {
  id: string;
  title: string;
  value: string;
  source: string;
  freshness: string;
  pinned: boolean;
  disabled: boolean;
}

export interface ProjectMemoryView {
  records: ProjectMemoryRecordView[];
  disabled: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => void | Promise<unknown>;
  promote: (sourceId: string) => Promise<unknown>;
  edit: (id: string, patch: { title: string; value: string }) => Promise<unknown>;
  togglePin: (id: string) => Promise<unknown>;
  toggleDisabled: (id: string) => Promise<unknown>;
  forget: (id: string) => Promise<unknown>;
  exportText: () => Promise<string>;
}

const EMPTY_PROJECT_MEMORY: ProjectMemoryView = {
  records: [], disabled: false, loading: false, error: null,
  refresh: async () => undefined,
  promote: async () => undefined,
  edit: async () => undefined,
  togglePin: async () => undefined,
  toggleDisabled: async () => undefined,
  forget: async () => undefined,
  exportText: async () => "# Memory export\n\n(no live memories)"
};

export function ProjectPage({
  project,
  onSaveGuidance,
  onReload,
  onNewChat,
  onSelectThread,
  knowledge,
  memory = EMPTY_PROJECT_MEMORY
}: {
  project: ProjectPageRecord;
  onSaveGuidance: (input: { description: string | null; instructions: string | null }) => Promise<void>;
  onReload: () => void | Promise<void>;
  onNewChat: () => void;
  onSelectThread: (thread: ThreadSummary) => void;
  knowledge: ProjectKnowledgeView;
  memory?: ProjectMemoryView;
}) {
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(project.description);
  const [instructions, setInstructions] = useState(project.instructions);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const [knowledgeResults, setKnowledgeResults] = useState<ProjectKnowledgeSourceView[] | null>(null);
  const [knowledgeBusy, setKnowledgeBusy] = useState(false);
  const [knowledgeActionError, setKnowledgeActionError] = useState("");
  const knowledgeFileRef = useRef<HTMLInputElement>(null);
  const [memoryBusyId, setMemoryBusyId] = useState<string | null>(null);
  const [memoryActionError, setMemoryActionError] = useState("");
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [memoryDraft, setMemoryDraft] = useState({ title: "", value: "" });
  const [memoryExport, setMemoryExport] = useState("");

  useEffect(() => {
    setDescription(project.description);
    setInstructions(project.instructions);
    setError("");
  }, [project.description, project.id, project.instructions, project.revision]);

  useEffect(() => {
    setKnowledgeQuery("");
    setKnowledgeResults(null);
    setKnowledgeActionError("");
    setMemoryBusyId(null);
    setMemoryActionError("");
    setEditingMemoryId(null);
    setMemoryExport("");
  }, [project.id]);

  const runMemoryAction = async (id: string, action: () => Promise<unknown>) => {
    setMemoryBusyId(id);
    setMemoryActionError("");
    try {
      await action();
    } catch (cause) {
      setMemoryActionError(cause instanceof Error ? cause.message : "Fable could not update this project memory.");
    } finally {
      setMemoryBusyId(null);
    }
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await onSaveGuidance({
        description: description.trim() || null,
        instructions: instructions.trim() || null
      });
      setEditing(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message.toLocaleLowerCase() : "";
      setError(message.includes("revision") || message.includes("changed")
        ? "This project changed somewhere else. Reload it before saving again."
        : "Couldn’t save the project guidance. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const visibleKnowledge = knowledgeResults ?? knowledge.sources;

  const runKnowledgeSearch = async () => {
    const query = knowledgeQuery.trim();
    if (!query) {
      setKnowledgeResults(null);
      setKnowledgeActionError("");
      return;
    }
    setKnowledgeBusy(true);
    setKnowledgeActionError("");
    try {
      setKnowledgeResults(await knowledge.search(query));
    } catch (cause) {
      setKnowledgeActionError(cause instanceof Error ? cause.message : "Couldn’t search this project’s knowledge. Try again.");
    } finally {
      setKnowledgeBusy(false);
    }
  };

  const importKnowledgeFile = async (file: File) => {
    setKnowledgeBusy(true);
    setKnowledgeActionError("");
    try {
      await knowledge.importFile(file);
      setKnowledgeResults(null);
    } catch (cause) {
      setKnowledgeActionError(cause instanceof Error ? cause.message : "Couldn’t add that file to this project. Try again.");
    } finally {
      setKnowledgeBusy(false);
    }
  };

  return (
    <div className="project-page">
      <PageHeader
        title={project.title}
        actions={project.lifecycle === "active" ? (
          <button type="button" className="project-page__new-chat" onClick={onNewChat}>
            <Plus size={15} weight="bold" aria-hidden="true" />
            New chat
          </button>
        ) : undefined}
      />

      <section className="project-page__section" aria-labelledby="project-guidance-heading">
        <div className="project-page__section-heading">
          <div>
            <h2 id="project-guidance-heading">Guidance</h2>
            <p>What Fable should keep in mind for this project.</p>
          </div>
          {!editing && project.lifecycle === "active" ? <button type="button" onClick={() => setEditing(true)}>Edit guidance</button> : null}
        </div>

        {editing ? (
          <form className="project-guidance-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <label>
              <span>Description</span>
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
            </label>
            <label>
              <span>Guidance for Fable</span>
              <textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} />
            </label>
            {error ? (
              <div className="project-guidance-form__error" role="alert">
                <p>{error}</p>
                <button type="button" onClick={() => void onReload()}>Reload project</button>
              </div>
            ) : null}
            <div className="project-guidance-form__actions">
              <button type="button" disabled={saving} onClick={() => {
                setDescription(project.description);
                setInstructions(project.instructions);
                setError("");
                setEditing(false);
              }}>Cancel</button>
              <button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
            </div>
          </form>
        ) : (
          <div className="project-guidance-copy">
            <div>
              <h3>Description</h3>
              <p>{project.description || "No description yet."}</p>
            </div>
            <div>
              <h3>Guidance for Fable</h3>
              <p>{project.instructions || "No guidance yet."}</p>
            </div>
          </div>
        )}
      </section>

      <section className="project-page__section" aria-labelledby="project-conversations-heading">
        <div className="project-page__section-heading">
          <div>
            <h2 id="project-conversations-heading">Conversations</h2>
            <p>Chats that share this project’s context.</p>
          </div>
          <span>{project.threads.length}</span>
        </div>
        {project.threads.length > 0 ? (
          <div className="project-page__thread-list">
            {project.threads.map((thread) => (
              <button key={thread.id} type="button" onClick={() => onSelectThread(thread)}>
                <strong>{thread.title}</strong>
                <span>{thread.description}</span>
              </button>
            ))}
          </div>
        ) : <p className="project-page__empty">No conversations yet.</p>}
      </section>

      <section className="project-page__section project-knowledge" aria-labelledby="project-knowledge-heading">
        <div className="project-page__section-heading">
          <div>
            <h2 id="project-knowledge-heading">Knowledge</h2>
            <p>Files Fable can use in this project.</p>
          </div>
          {project.lifecycle === "active" ? (
            <button type="button" disabled={knowledgeBusy} onClick={() => knowledgeFileRef.current?.click()}>
              <FilePlus size={15} aria-hidden="true" /> Add files
            </button>
          ) : <span className="project-knowledge__read-only">Read only</span>}
        </div>

        <input
          ref={knowledgeFileRef}
          className="sr-only"
          type="file"
          aria-label="Choose a project knowledge file"
          accept=".txt,.md,.markdown,.json,.csv,.yaml,.yml,text/plain,text/markdown,application/json,text/csv,application/yaml"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void importKnowledgeFile(file);
          }}
        />

        <form className="project-knowledge__search" role="search" onSubmit={(event) => { event.preventDefault(); void runKnowledgeSearch(); }}>
          <MagnifyingGlass size={15} aria-hidden="true" />
          <label className="sr-only" htmlFor={`project-knowledge-search-${project.id}`}>Search project knowledge</label>
          <input
            id={`project-knowledge-search-${project.id}`}
            type="search"
            value={knowledgeQuery}
            placeholder="Search project knowledge"
            onChange={(event) => {
              setKnowledgeQuery(event.target.value);
              if (!event.target.value.trim()) setKnowledgeResults(null);
            }}
          />
          <button type="submit" disabled={knowledgeBusy || !knowledgeQuery.trim()}>Search</button>
        </form>

        {knowledge.error ? (
          <div className="project-knowledge__state" role="alert">
            <p>{knowledge.error}</p>
            <button type="button" onClick={() => void knowledge.refresh()}>Try again</button>
          </div>
        ) : null}
        {knowledgeActionError ? <p className="project-knowledge__state project-knowledge__state--error" role="alert">{knowledgeActionError}</p> : null}
        {knowledge.loading ? <p className="project-knowledge__state" role="status">Loading project knowledge…</p> : null}
        {!knowledge.loading && !knowledge.error && visibleKnowledge.length === 0 ? (
          <p className="project-page__empty">{knowledgeResults ? "No matching project knowledge." : "No files added yet."}</p>
        ) : null}
        {!knowledge.loading && !knowledge.error && visibleKnowledge.length > 0 ? (
          <ul className="project-knowledge__list" aria-label="Project knowledge sources">
            {visibleKnowledge.map((source) => (
              <li key={source.id}>
                <div>
                  <strong>{source.title}</strong>
                  <span>{source.provenance}</span>
                </div>
                <div className="project-knowledge__meta">
                  <span>{source.status === "indexing" ? "Indexing" : source.status === "stale" ? "Needs refresh" : source.status === "error" ? "Import failed" : source.freshness}</span>
                  {source.statusMessage ? <span title={source.statusMessage}>{source.statusMessage}</span> : null}
                </div>
                {project.lifecycle === "active" ? (
                  <button
                    type="button"
                    disabled={memoryBusyId === source.id || memory.disabled}
                    onClick={() => void runMemoryAction(source.id, () => memory.promote(source.id))}
                  >
                    {memoryBusyId === source.id ? "Rememberingâ€¦" : "Remember"}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="project-page__section project-memory" aria-labelledby="project-memory-heading">
        <div className="project-page__section-heading">
          <div>
            <h2 id="project-memory-heading">Memory</h2>
            <p>Details Fable should remember only for this project.</p>
          </div>
          <button
            type="button"
            className="project-memory__export"
            disabled={memory.loading}
            onClick={() => void runMemoryAction("export", async () => setMemoryExport(await memory.exportText()))}
          >
            <DownloadSimple size={15} aria-hidden="true" /> Export
          </button>
        </div>

        {project.lifecycle === "archived" ? <p className="project-memory__read-only">Archived projects are read only.</p> : null}
        {memory.disabled ? <p className="project-memory__state">Memory is turned off for this project.</p> : null}
        {memory.error ? (
          <div className="project-memory__state project-memory__state--error" role="alert">
            <p>{memory.error}</p>
            <button type="button" onClick={() => void memory.refresh()}>Try again</button>
          </div>
        ) : null}
        {memoryActionError ? <p className="project-memory__state project-memory__state--error" role="alert">{memoryActionError}</p> : null}
        {memory.loading ? <p className="project-memory__state" role="status">Loading project memoryâ€¦</p> : null}
        {!memory.loading && !memory.error && memory.records.length === 0 ? (
          <p className="project-page__empty">Nothing remembered yet. Choose Remember beside a knowledge file to add it.</p>
        ) : null}
        {!memory.loading && !memory.error && memory.records.length > 0 ? (
          <ul className="project-memory__list" aria-label="Project memory">
            {memory.records.map((record) => (
              <li key={record.id} className={record.disabled ? "project-memory__item project-memory__item--disabled" : "project-memory__item"}>
                {editingMemoryId === record.id ? (
                  <form onSubmit={(event) => {
                    event.preventDefault();
                    void runMemoryAction(record.id, async () => {
                      await memory.edit(record.id, memoryDraft);
                      setEditingMemoryId(null);
                    });
                  }}>
                    <label>
                      <span>Memory title</span>
                      <input value={memoryDraft.title} onChange={(event) => setMemoryDraft((draft) => ({ ...draft, title: event.target.value }))} />
                    </label>
                    <label>
                      <span>What Fable should remember</span>
                      <textarea value={memoryDraft.value} onChange={(event) => setMemoryDraft((draft) => ({ ...draft, value: event.target.value }))} />
                    </label>
                    <div className="project-memory__actions">
                      <button type="button" onClick={() => setEditingMemoryId(null)}>Cancel</button>
                      <button type="submit" disabled={memoryBusyId === record.id || !memoryDraft.title.trim() || !memoryDraft.value.trim()}>Save memory</button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className="project-memory__copy">
                      <strong>{record.title}</strong>
                      <p>{record.value}</p>
                      <span>{record.source} Â· {record.freshness}</span>
                      <div className="project-memory__badges">
                        {record.pinned ? <span>Pinned</span> : null}
                        {record.disabled ? <span>Not in use</span> : null}
                      </div>
                    </div>
                    {project.lifecycle === "active" ? (
                      <div className="project-memory__actions">
                        <button type="button" disabled={memoryBusyId === record.id} onClick={() => {
                          setMemoryDraft({ title: record.title, value: record.value });
                          setEditingMemoryId(record.id);
                        }}>Edit</button>
                        <button type="button" disabled={memoryBusyId === record.id || record.disabled} onClick={() => void runMemoryAction(record.id, () => memory.togglePin(record.id))}>{record.pinned ? "Unpin" : "Pin"}</button>
                        <button type="button" disabled={memoryBusyId === record.id} onClick={() => void runMemoryAction(record.id, () => memory.toggleDisabled(record.id))}>{record.disabled ? "Use again" : "Stop using"}</button>
                        <button type="button" className="project-memory__forget" disabled={memoryBusyId === record.id} onClick={() => {
                          if (window.confirm(`Forget â€œ${record.title}â€? This cannot be undone.`)) {
                            void runMemoryAction(record.id, () => memory.forget(record.id));
                          }
                        }}>Forget</button>
                      </div>
                    ) : null}
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {memoryExport ? <pre className="project-memory__export-text" aria-label="Project memory export">{memoryExport}</pre> : null}
      </section>
    </div>
  );
}

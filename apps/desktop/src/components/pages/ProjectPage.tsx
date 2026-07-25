import { useEffect, useRef, useState } from "react";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { FilePlus } from "@phosphor-icons/react/dist/csr/FilePlus";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { DownloadSimple } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import type { SourceStatus, ThreadSummary } from "@fable/protocol";
import type { ProjectActivityView } from "../../hooks/useProjectActivity";
import { PageHeader } from "../PageHeader";

export interface ProjectPageRecord {
  id: string;
  title: string;
  description: string;
  instructions: string;
  connectionIds?: readonly string[];
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
  disabled?: boolean;
}

export interface ProjectKnowledgeView {
  sources: ProjectKnowledgeSourceView[];
  loading: boolean;
  error: string | null;
  actionStatus: string | null;
  refresh: () => void | Promise<unknown>;
  importFile: (file: File) => Promise<unknown>;
  search: (query: string) => Promise<ProjectKnowledgeSourceView[]>;
  toggleDisabled: (sourceId: string) => Promise<unknown>;
  remove: (sourceId: string) => Promise<unknown>;
  updateFile: (sourceId: string, file: File) => Promise<unknown>;
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

function memoryPreview(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 280 ? `${compact.slice(0, 277).trimEnd()}...` : compact;
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

const EMPTY_PROJECT_ACTIVITY: ProjectActivityView = {
  missions: [],
  routines: [],
  artifacts: [],
  connections: [],
  connectionOptions: [],
  loading: false,
  error: null,
  truncated: false,
  refresh: async () => undefined
};

export function ProjectPage({
  project,
  onSaveGuidance,
  onReload,
  onNewChat,
  onSelectThread,
  onExportCopy,
  onSaveConnections,
  knowledge,
  memory = EMPTY_PROJECT_MEMORY,
  activity = EMPTY_PROJECT_ACTIVITY
}: {
  project: ProjectPageRecord;
  onSaveGuidance: (input: { description: string | null; instructions: string | null }) => Promise<void>;
  onReload: () => void | Promise<void>;
  onNewChat: () => void;
  onSelectThread: (thread: ThreadSummary) => void;
  onExportCopy?: (destination: string) => Promise<boolean>;
  onSaveConnections?: (connectionIds: string[]) => Promise<void>;
  knowledge: ProjectKnowledgeView;
  memory?: ProjectMemoryView;
  activity?: ProjectActivityView;
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
  const [knowledgeActionId, setKnowledgeActionId] = useState<string | null>(null);
  const knowledgeFileRef = useRef<HTMLInputElement>(null);
  const [memoryBusyId, setMemoryBusyId] = useState<string | null>(null);
  const [memoryActionError, setMemoryActionError] = useState("");
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [memoryDraft, setMemoryDraft] = useState({ title: "", value: "" });
  const [memoryExport, setMemoryExport] = useState("");
  const [projectExportPath, setProjectExportPath] = useState("");
  const [projectExportBusy, setProjectExportBusy] = useState(false);
  const [projectExportStatus, setProjectExportStatus] = useState("");
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState("");

  useEffect(() => {
    setDescription(project.description);
    setInstructions(project.instructions);
    setError("");
  }, [project.description, project.id, project.instructions, project.revision]);

  useEffect(() => {
    setKnowledgeQuery("");
    setKnowledgeResults(null);
    setKnowledgeActionError("");
    setKnowledgeActionId(null);
    setMemoryBusyId(null);
    setMemoryActionError("");
    setEditingMemoryId(null);
    setMemoryExport("");
    setProjectExportPath("");
    setProjectExportStatus("");
    setConnectionStatus("");
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

  const saveConnections = async (connectionIds: string[]) => {
    if (!onSaveConnections) return;
    setConnectionBusy(true);
    setConnectionStatus("");
    try {
      await onSaveConnections(connectionIds);
      setConnectionStatus("Project Connections saved.");
    } catch (cause) {
      setConnectionStatus(`!${cause instanceof Error
        ? cause.message
        : "Fable could not save this Project's Connections."}`);
    } finally {
      setConnectionBusy(false);
    }
  };

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

  const runKnowledgeAction = async (sourceId: string, action: () => Promise<unknown>) => {
    setKnowledgeActionId(sourceId);
    setKnowledgeActionError("");
    try {
      await action();
      setKnowledgeResults(null);
    } catch (cause) {
      setKnowledgeActionError(cause instanceof Error ? cause.message : "Fable could not update that project source.");
    } finally {
      setKnowledgeActionId(null);
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

      <section className="project-page__section project-activity" aria-labelledby="project-activity-heading">
        <div className="project-page__section-heading">
          <div>
            <h2 id="project-activity-heading">Activity</h2>
            <p>Runs, routines, saved work, and Connections used by this project.</p>
          </div>
          <button type="button" disabled={activity.loading} onClick={() => void activity.refresh()}>
            {activity.loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {activity.error ? (
          <div className="project-activity__state project-activity__state--error" role="alert">
            <p>{activity.error}</p>
            <button type="button" onClick={() => void activity.refresh()}>Try again</button>
          </div>
        ) : null}
        {activity.loading ? <p className="project-activity__state" role="status">Loading project activity...</p> : null}
        {!activity.loading && !activity.error ? (
          <>
            <ul className="project-activity__counts" aria-label="Project activity summary">
              <li><strong>{activity.missions.length}</strong><span>Mission runs</span></li>
              <li><strong>{activity.routines.length}</strong><span>Routines</span></li>
              <li><strong>{activity.artifacts.length}</strong><span>Artifacts</span></li>
            </ul>

            <div className="project-activity__groups">
              <div>
                <h3>Missions</h3>
                {activity.missions.length > 0 ? (
                  <ul aria-label="Project Mission runs">
                    {activity.missions.map((mission) => {
                      const thread = project.threads.find((candidate) => candidate.id === mission.threadId);
                      return (
                        <li key={mission.runId}>
                          {thread ? (
                            <button type="button" onClick={() => onSelectThread(thread)}>
                              <strong>{mission.title}</strong>
                              <span>{mission.state} · {mission.detail}</span>
                              <small>{mission.conversation}</small>
                            </button>
                          ) : (
                            <div>
                              <strong>{mission.title}</strong>
                              <span>{mission.state} · {mission.detail}</span>
                              <small>{mission.conversation}</small>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : <p className="project-page__empty">No Mission runs yet.</p>}
              </div>

              <div>
                <h3>Routines</h3>
                {activity.routines.length > 0 ? (
                  <ul aria-label="Project Routines">
                    {activity.routines.map((routine) => (
                      <li key={routine.id}>
                        <div>
                          <strong>{routine.title}</strong>
                          <span>{routine.status} · {routine.detail}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : <p className="project-page__empty">No Routines yet.</p>}
              </div>

              <div>
                <h3>Artifacts</h3>
                {activity.artifacts.length > 0 ? (
                  <ul aria-label="Project Artifacts">
                    {activity.artifacts.map((artifact) => (
                      <li key={artifact.id}>
                        <div>
                          <strong>{artifact.title}</strong>
                          <span>{artifact.status} · {artifact.detail}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : <p className="project-page__empty">No Artifacts yet.</p>}
              </div>
            </div>

            <div className="project-activity__connections">
              <div className="project-activity__connections-heading">
                <h3>Connections</h3>
                <p>Choose existing Connections Fable may use for this Project. This does not grant new access.</p>
              </div>
              {project.lifecycle === "active" && onSaveConnections ? (
                <form onSubmit={(event) => {
                  event.preventDefault();
                  void saveConnections(
                    new FormData(event.currentTarget).getAll("connectionIds").map(String)
                  );
                }}>
                  {activity.connectionOptions.length > 0 ? (
                    <select
                      key={`${project.id}:${project.revision}`}
                      aria-label="Connections available to this Project"
                      name="connectionIds"
                      multiple
                      defaultValue={[...(project.connectionIds ?? [])]}
                      disabled={connectionBusy}
                    >
                      {activity.connectionOptions.map((connection) => (
                        <option
                          key={connection.id}
                          value={connection.id}
                          disabled={!connection.selectable && !project.connectionIds?.includes(connection.id)}
                        >
                          {connection.name} · {connection.status}
                        </option>
                      ))}
                    </select>
                  ) : <p className="project-page__empty">No Connections are ready yet.</p>}
                  {activity.connectionOptions.length > 0 ? (
                    <div className="project-guidance-form__actions">
                      <button type="submit" disabled={connectionBusy}>
                      {connectionBusy ? "Saving..." : "Save Connections"}
                      </button>
                    </div>
                  ) : null}
                </form>
              ) : activity.connections.length > 0 ? (
                <ul aria-label="Connections used by this project">
                  {activity.connections.map((connection) => (
                    <li key={connection.id}>
                      <span>{connection.name}</span>
                      <strong>{connection.status}</strong>
                    </li>
                  ))}
                </ul>
              ) : <p className="project-page__empty">No Connections chosen or used yet.</p>}
              {connectionStatus ? (
                <p role={connectionStatus.startsWith("!") ? "alert" : "status"}>
                  {connectionStatus.replace(/^!/, "")}
                </p>
              ) : null}
            </div>
            {activity.truncated ? (
              <p className="project-activity__state">Showing the newest bounded activity. Older records remain stored.</p>
            ) : null}
          </>
        ) : null}
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

        {project.lifecycle === "active" ? (
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
        ) : null}

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
        {knowledge.actionStatus ? <p className="project-knowledge__state" role="status">{knowledge.actionStatus}</p> : null}
        {knowledge.loading ? <p className="project-knowledge__state" role="status">Loading project knowledge…</p> : null}
        {!knowledge.loading && !knowledge.error && visibleKnowledge.length === 0 ? (
          <p className="project-page__empty">{knowledgeResults ? "No matching project knowledge." : "No files added yet."}</p>
        ) : null}
        {!knowledge.loading && !knowledge.error && visibleKnowledge.length > 0 ? (
          <ul className="project-knowledge__list" aria-label="Project knowledge sources">
            {visibleKnowledge.map((source) => (
              <li key={source.id} className={source.disabled ? "project-knowledge__item project-knowledge__item--disabled" : "project-knowledge__item"}>
                <div>
                  <strong>{source.title}</strong>
                  <span>{source.provenance}</span>
                </div>
                <div className="project-knowledge__meta">
                  <span>{source.disabled ? "Not in use" : source.status === "indexing" ? "Indexing" : source.status === "stale" ? "Needs refresh" : source.status === "error" ? "Import failed" : source.freshness}</span>
                  {source.statusMessage ? <span title={source.statusMessage}>{source.statusMessage}</span> : null}
                </div>
                {project.lifecycle === "active" ? (
                  <>
                  <div className="project-knowledge__actions">
                    <label className="project-knowledge__update-file">
                      <span>{knowledgeActionId === source.id ? "Updating..." : "Update file"}</span>
                      <input
                        className="sr-only"
                        type="file"
                        aria-label={`Choose the current version of ${source.title}`}
                        disabled={knowledgeActionId === source.id}
                        accept=".txt,.md,.markdown,.json,.csv,.yaml,.yml,text/plain,text/markdown,application/json,text/csv,application/yaml"
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          event.currentTarget.value = "";
                          if (file) void runKnowledgeAction(source.id, () => knowledge.updateFile(source.id, file));
                        }}
                      />
                    </label>
                    {!source.disabled ? (
                      <button
                        type="button"
                        disabled={memoryBusyId === source.id || memory.disabled || knowledgeActionId === source.id}
                        onClick={() => void runMemoryAction(source.id, () => memory.promote(source.id))}
                      >
                        {memoryBusyId === source.id ? "Remembering..." : "Remember"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={knowledgeActionId === source.id}
                      onClick={() => void runKnowledgeAction(source.id, () => knowledge.toggleDisabled(source.id))}
                    >{source.disabled ? "Use again" : "Stop using"}</button>
                    <button
                      type="button"
                      className="project-knowledge__delete"
                      disabled={knowledgeActionId === source.id}
                      onClick={() => {
                        if (window.confirm(`Delete "${source.title}" from this project?`)) {
                          void runKnowledgeAction(source.id, () => knowledge.remove(source.id));
                        }
                      }}
                    >Delete</button>
                  </div>
                  <p className="project-knowledge__update-help">Choose the current version of this file. Fable won't keep access to its location.</p>
                  </>
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
        {memory.loading ? <p className="project-memory__state" role="status">Loading project memory...</p> : null}
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
                      <p>{memoryPreview(record.value)}</p>
                      <span>{record.source} / {record.freshness}</span>
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
                          if (window.confirm(`Forget "${record.title}"? This cannot be undone.`)) {
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

      {onExportCopy ? (
        <section className="project-page__section project-copy" aria-labelledby="project-copy-heading">
          <div className="project-page__section-heading">
            <div>
              <h2 id="project-copy-heading">Project copy</h2>
              <p>Save this project's conversations, runs, saved work, Knowledge, Memory, and Routines as readable JSON.</p>
            </div>
          </div>
          <label className="settings-field">
            <span>New project-copy file</span>
            <input
              value={projectExportPath}
              onChange={(event) => {
                setProjectExportPath(event.target.value);
                setProjectExportStatus("");
              }}
              placeholder="Choose a new .json file path"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <p className="project-memory__read-only">
            This copy contains no credentials, but its project content is readable without Fable. Existing files are never overwritten.
          </p>
          <button
            type="button"
            className="project-memory__export"
            disabled={projectExportBusy || !projectExportPath.trim()}
            onClick={() => {
              const destination = projectExportPath.trim();
              if (!destination) return;
              setProjectExportBusy(true);
              setProjectExportStatus("");
              void onExportCopy(destination)
                .then((exported) => {
                  setProjectExportStatus(exported
                    ? "Project copy created."
                    : "Project copies are available only in the Fable desktop app.");
                  if (exported) setProjectExportPath("");
                })
                .catch((cause) => {
                  setProjectExportStatus(cause instanceof Error
                    ? cause.message
                    : "Fable could not export this project.");
                })
                .finally(() => setProjectExportBusy(false));
            }}
          >
            <DownloadSimple size={15} aria-hidden="true" />
            {projectExportBusy ? "Exporting..." : "Export project copy"}
          </button>
          {projectExportStatus ? <p className="project-memory__state" role="status">{projectExportStatus}</p> : null}
        </section>
      ) : null}
    </div>
  );
}

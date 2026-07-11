import { useEffect, useState } from "react";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import type { ThreadSummary } from "@fable/protocol";
import { PageHeader } from "../PageHeader";

export interface ProjectPageRecord {
  id: string;
  title: string;
  description: string;
  instructions: string;
  revision: number;
  threads: ThreadSummary[];
}

export function ProjectPage({
  project,
  onSaveGuidance,
  onReload,
  onNewChat,
  onSelectThread
}: {
  project: ProjectPageRecord;
  onSaveGuidance: (input: { description: string | null; instructions: string | null }) => Promise<void>;
  onReload: () => void | Promise<void>;
  onNewChat: () => void;
  onSelectThread: (thread: ThreadSummary) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(project.description);
  const [instructions, setInstructions] = useState(project.instructions);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setDescription(project.description);
    setInstructions(project.instructions);
    setError("");
  }, [project.description, project.id, project.instructions, project.revision]);

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

  return (
    <div className="project-page">
      <PageHeader
        title={project.title}
        actions={
          <button type="button" className="project-page__new-chat" onClick={onNewChat}>
            <Plus size={15} weight="bold" aria-hidden="true" />
            New chat
          </button>
        }
      />

      <section className="project-page__section" aria-labelledby="project-guidance-heading">
        <div className="project-page__section-heading">
          <div>
            <h2 id="project-guidance-heading">Guidance</h2>
            <p>What Fable should keep in mind for this project.</p>
          </div>
          {!editing ? <button type="button" onClick={() => setEditing(true)}>Edit guidance</button> : null}
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
    </div>
  );
}

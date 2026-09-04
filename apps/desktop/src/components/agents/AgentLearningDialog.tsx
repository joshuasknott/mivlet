import { GraduationCap } from "@phosphor-icons/react/dist/csr/GraduationCap";
import { PencilSimple } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { Play } from "@phosphor-icons/react/dist/csr/Play";
import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import { X } from "@phosphor-icons/react/dist/csr/X";
import type { FableAgentProfile, FableLearnedTask } from "@fable/protocol";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import {
  suggestedLearnedTask,
  upsertLearnedTask,
} from "../../lib/agent-learning";
import { ProfileAgentAvatar } from "./agent-icons";

export interface AgentLearningSource {
  prompt: string;
  response: string;
}

interface LearningDraft {
  title: string;
  instruction: string;
}

function newTaskId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `learned-${crypto.randomUUID()}`;
  }
  return `learned-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function AgentLearningDialog({
  open,
  agent,
  source,
  startCreating = false,
  onClose,
  onChange,
  onRun,
}: {
  open: boolean;
  agent: FableAgentProfile;
  source: AgentLearningSource | null;
  startCreating?: boolean;
  onClose: () => void;
  onChange: (tasks: FableLearnedTask[]) => void;
  onRun: (task: FableLearnedTask) => void;
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(startCreating);
  const [draft, setDraft] = useState<LearningDraft>({
    title: "",
    instruction: "",
  });

  const tasks = agent.learnedTasks ?? [];
  const teaching = source !== null || editingId !== null || creating;

  useEffect(() => {
    if (!open) return;
    if (source) {
      setEditingId(null);
      setCreating(false);
      setDraft(suggestedLearnedTask(source.prompt));
    } else {
      setEditingId(null);
      setCreating(startCreating);
      setDraft({ title: "", instruction: "" });
      if (startCreating) {
        window.setTimeout(() => titleRef.current?.focus(), 0);
      }
    }
  }, [open, source, startCreating]);

  useModalFocusTrap({
    active: open,
    containerRef: modalRef,
    initialFocusRef: source || startCreating ? titleRef : closeRef,
    onClose,
  });

  if (!open) return null;

  const editTask = (task: FableLearnedTask) => {
    setEditingId(task.id);
    setCreating(false);
    setDraft({ title: task.title, instruction: task.instruction });
    window.setTimeout(() => titleRef.current?.focus(), 0);
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    const title = draft.title.trim().slice(0, 120);
    const instruction = draft.instruction.trim().slice(0, 4_000);
    if (!title || !instruction) return;
    const existing = editingId
      ? tasks.find((task) => task.id === editingId)
      : undefined;
    const now = new Date().toISOString();
    const task: FableLearnedTask = {
      id: existing?.id ?? newTaskId(),
      title,
      instruction,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    onChange(upsertLearnedTask(tasks, task));
    if (source) {
      onClose();
      return;
    }
    setEditingId(null);
    setCreating(false);
    setDraft({ title: "", instruction: "" });
  };

  return (
    <div className="agent-learning-backdrop" role="presentation">
      <div
        ref={modalRef}
        className="agent-learning-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-learning-title"
      >
        <header className="agent-learning-dialog__header">
          <div className="agent-learning-dialog__identity">
            <ProfileAgentAvatar agent={agent} iconSize={26} />
            <div>
              <span>
                <GraduationCap size={14} aria-hidden="true" /> Learned work
              </span>
              <h2 id="agent-learning-title">
                {source
                  ? `Teach ${agent.name} this task`
                  : `${agent.name}'s responsibilities`}
              </h2>
              <p>
                {source
                  ? "Turn this exchange into guidance the teammate will use in future conversations."
                  : "Review the repeatable work you have explicitly taught this teammate."}
              </p>
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close learned work"
          >
            <X size={18} />
          </button>
        </header>

        {teaching ? (
          <form onSubmit={save}>
            <label className="agent-learning-dialog__field">
              <span>Responsibility</span>
              <input
                ref={titleRef}
                required
                maxLength={120}
                value={draft.title}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    title: event.target.value,
                  }))
                }
                placeholder="Prepare the weekly launch update"
              />
            </label>
            <label className="agent-learning-dialog__field">
              <span>What to repeat</span>
              <textarea
                required
                rows={5}
                maxLength={4_000}
                value={draft.instruction}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    instruction: event.target.value,
                  }))
                }
                placeholder="Describe the outcome, sources, and quality bar."
              />
            </label>
            {source ? (
              <details className="agent-learning-dialog__example">
                <summary>Example outcome from this conversation</summary>
                <p>{source.response}</p>
              </details>
            ) : null}
            <footer>
              <button
                type="button"
                onClick={() => {
                  if (source) {
                    onClose();
                  } else {
                    setEditingId(null);
                    setCreating(false);
                    setDraft({ title: "", instruction: "" });
                  }
                }}
              >
                Cancel
              </button>
              <button className="agent-learning-dialog__save" type="submit">
                {editingId ? "Save responsibility" : "Teach task"}
              </button>
            </footer>
          </form>
        ) : (
          <div className="agent-learning-dialog__list">
            {tasks.length ? (
              <>
                <div className="agent-learning-dialog__list-header">
                  <span>
                    {tasks.length} learned skill{tasks.length === 1 ? "" : "s"}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setCreating(true);
                      setDraft({ title: "", instruction: "" });
                      window.setTimeout(() => titleRef.current?.focus(), 0);
                    }}
                  >
                    Add skill
                  </button>
                </div>
                <ul>
                  {tasks.map((task) => (
                    <li key={task.id}>
                      <div>
                        <strong>{task.title}</strong>
                        <p>{task.instruction}</p>
                      </div>
                      <span>
                        <button
                          type="button"
                          onClick={() => onRun(task)}
                          aria-label={`Run ${task.title}`}
                        >
                          <Play size={16} />
                        </button>
                        <button
                          type="button"
                          onClick={() => editTask(task)}
                          aria-label={`Edit ${task.title}`}
                        >
                          <PencilSimple size={16} />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            onChange(
                              tasks.filter(
                                (candidate) => candidate.id !== task.id,
                              ),
                            )
                          }
                          aria-label={`Forget ${task.title}`}
                        >
                          <Trash size={16} />
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div className="agent-learning-dialog__empty">
                <GraduationCap size={28} aria-hidden="true" />
                <strong>No learned work yet</strong>
                <p>
                  After a useful response, choose “Teach this” to make the
                  approach repeatable.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setCreating(true);
                    window.setTimeout(() => titleRef.current?.focus(), 0);
                  }}
                >
                  Create a skill
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

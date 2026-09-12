import { useId, useRef, useState } from "react";
import type { FableAgentProfile } from "@fable/protocol";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { ProfileAgentAvatar } from "../agents/agent-icons";

export interface ConversationDraft {
  kind: "direct" | "group" | "project";
  title: string;
  instructions: string;
  participantIds: string[];
  facilitatorId: string;
  shareHistory: boolean;
}

export function ConversationDialog({
  agents,
  initial,
  edit = false,
  projectName,
  onSave,
  onClose,
}: {
  agents: FableAgentProfile[];
  initial?: Partial<ConversationDraft>;
  edit?: boolean;
  projectName?: string;
  onSave: (draft: ConversationDraft) => Promise<void>;
  onClose: () => void;
}) {
  const [kind] = useState<ConversationDraft["kind"]>(initial?.kind ?? "direct");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [ids, setIds] = useState(
    initial?.participantIds ?? agents.slice(0, 1).map((agent) => agent.id),
  );
  const [facilitator, setFacilitator] = useState(
    initial?.facilitatorId ?? agents[0]?.id ?? "",
  );
  const explicitParticipants = useRef(new Set(initial?.participantIds?.filter(id => id !== initial.facilitatorId)));
  const [share, setShare] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const heading = useId();
  useModalFocusTrap({
    active: true,
    containerRef: panel,
    onClose: () => {
      if (!pending) onClose();
    },
  });
  const added =
    edit && ids.some((id) => !initial?.participantIds?.includes(id));
  const label =
    kind === "project"
      ? "project"
      : kind === "group"
        ? "group"
        : "conversation";
  return (
    <div className="modal-backdrop team-dialog-backdrop">
      <div
        className="team-dialog"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={heading}
      >
        <header>
          <h2 id={heading}>
            {edit
              ? `Edit ${label}`
              : projectName
                ? `Conversation in ${projectName}`
                : `New ${label}`}
          </h2>
          <button
            type="button"
            disabled={pending}
            aria-label="Close dialog"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (kind === "group" && !projectName && ids.length < 2) {
              setError("Choose at least two participants for a group.");
              return;
            }
            if (!ids.length || !ids.includes(facilitator)) {
              setError("Choose a lead from the participants.");
              return;
            }
            setPending(true);
            setError("");
            void onSave({
              kind,
              title:
                title.trim() ||
                (kind === "direct"
                  ? `Conversation with ${agents.find((agent) => agent.id === facilitator)?.name ?? "agent"}`
                  : "New group"),
              instructions,
              participantIds: kind === "direct" ? [facilitator] : ids,
              facilitatorId: facilitator,
              shareHistory: share,
            })
              .then(onClose)
              .catch((error) =>
                setError(
                  error instanceof Error
                    ? error.message
                    : "Could not save this conversation.",
                ),
              )
              .finally(() => setPending(false));
          }}
        >
          <label>
            {kind === "project" ? "Project name" : "Conversation title"}
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={120}
              placeholder={
                kind === "direct"
                  ? "Optional title"
                  : kind === "project"
                    ? "What are we working towards?"
                    : "What is this group for?"
              }
              required={kind === "project"}
            />
          </label>
          {kind === "project" ? (
            <label>
              Instructions
              <textarea
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                rows={4}
                maxLength={6000}
                placeholder="Purpose, constraints, and what a useful result looks like"
              />
            </label>
          ) : null}
          <label>
            {kind === "direct" ? "Teammate" : "Lead"}
            <select
              value={facilitator}
              onChange={(event) => {
                setFacilitator(event.target.value);
                setIds(
                  kind === "direct"
                    ? [event.target.value]
                    : [...new Set([...ids.filter(id => edit || id !== facilitator || explicitParticipants.current.has(id)), event.target.value])],
                );
              }}
              required
            >
              <option value="" disabled>
                Choose an existing agent
              </option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
          {kind !== "direct" ? (
            <fieldset className="team-member-picker">
              <legend>
                Participants <small>Up to eight</small>
              </legend>
              {agents.map((agent) => (
                <label key={agent.id}>
                  <input
                    type="checkbox"
                    checked={ids.includes(agent.id)}
                    disabled={
                      agent.id === facilitator ||
                      (!ids.includes(agent.id) && ids.length >= 8)
                    }
                    onChange={(event) => {
                      if (event.target.checked) explicitParticipants.current.add(agent.id);
                      else explicitParticipants.current.delete(agent.id);
                      setIds(
                        event.target.checked
                          ? [...ids, agent.id]
                          : ids.filter((id) => id !== agent.id),
                      );
                    }}
                  />
                  <ProfileAgentAvatar agent={agent} iconSize={27} />
                  <span>{agent.name}</span>
                  {agent.id === facilitator ? (
                    <small>Lead</small>
                  ) : null}
                </label>
              ))}
            </fieldset>
          ) : null}
          {kind !== "direct" ? (
            <p className="team-dialog-note">
              Participants use their own selected models. They receive this
              conversation’s shared history
              {kind === "project"
                ? ", project references, decisions and work records"
                : ""}
              . Their private conversations remain separate.
            </p>
          ) : null}
          {edit ? (
            <p className="team-dialog-note">
              Changing participants or the lead pauses active assignments for
              review. Existing messages keep their original authors.
            </p>
          ) : null}
          {added ? (
            <label className="team-consent">
              <input
                type="checkbox"
                checked={share}
                onChange={(event) => setShare(event.target.checked)}
                required
              />{" "}
              Share existing history and project context with the added
              participants
            </label>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
          <footer>
            <button
              type="button"
              className="button button--secondary"
              disabled={pending}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="button button--primary"
              disabled={pending}
            >
              {pending ? "Saving…" : edit ? "Save changes" : `Create ${label}`}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

export function PlaceConversationDialog({
  title,
  projects,
  onPlace,
  onClose,
}: {
  title: string;
  projects: { id: string; name: string }[];
  onPlace: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const [id, setId] = useState(projects[0]?.id ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const heading = useId();
  useModalFocusTrap({
    active: true,
    containerRef: panel,
    onClose: () => {
      if (!pending) onClose();
    },
  });
  return (
    <div className="modal-backdrop team-dialog-backdrop">
      <div
        className="team-dialog"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={heading}
      >
        <header>
          <h2 id={heading}>Place conversation in a project</h2>
          <button
            type="button"
            disabled={pending}
            onClick={onClose}
            aria-label="Close dialog"
          >
            ×
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setPending(true);
            void onPlace(id)
              .then(onClose)
              .catch((error) =>
                setError(
                  error instanceof Error
                    ? error.message
                    : "Could not move this conversation.",
                ),
              )
              .finally(() => setPending(false));
          }}
        >
          <p>
            “{title}” will become a shared project conversation. Existing
            messages and attached context will be available to the project’s
            participants. Active work will pause for review.
          </p>
          <label>
            Project
            <select
              required
              value={id}
              onChange={(event) => setId(event.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="team-consent">
            <input type="checkbox" required /> Share this conversation’s
            existing history with the project
          </label>
          {error ? <p role="alert">{error}</p> : null}
          <footer>
            <button type="button" disabled={pending} onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="button button--primary"
              disabled={pending || !id}
            >
              {pending ? "Moving…" : "Share with project"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

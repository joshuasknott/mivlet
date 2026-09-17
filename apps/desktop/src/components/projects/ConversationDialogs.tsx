import { useId, useRef, useState } from "react";
import type { BackendProvider, MivletAgentProfile } from "@mivlet/protocol";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import type { ProviderModelOption } from "../../lib/provider-models";
import { ProfileAgentAvatar } from "../agents/agent-icons";
import { TeamReadiness } from "./TeamReadiness";

export interface ConversationDraft {
  kind: "direct" | "project";
  title: string;
  instructions: string;
  participantIds: string[];
  /** Empty when the Project Team has no designated coordinator. */
  facilitatorId: string;
  shareHistory: boolean;
}

export function ConversationDialog({
  agents,
  models = [],
  providers = [],
  initial,
  edit = false,
  projectName,
  onSave,
  onClose,
}: {
  agents: MivletAgentProfile[];
  models?: ProviderModelOption[];
  providers?: BackendProvider[];
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
    initial?.participantIds ??
      (initial?.kind === "project"
        ? []
        : agents.slice(0, 1).map((agent) => agent.id)),
  );
  const [facilitator, setFacilitator] = useState(
    initial?.facilitatorId ?? (kind === "direct" ? (agents[0]?.id ?? "") : ""),
  );
  const explicitParticipants = useRef(new Set(initial?.participantIds));
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
  const added = edit && ids.some((id) => !initial?.participantIds?.includes(id));
  const label = kind === "project" ? "project" : "conversation";
  const coordinator = agents.find((agent) => agent.id === facilitator);
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
            if (!ids.length || ids.length > 8) {
              setError("Choose one to eight participants.");
              return;
            }
            if (kind === "direct" && ids.length !== 1) {
              setError("A conversation has exactly one teammate.");
              return;
            }
            if (facilitator && !ids.includes(facilitator)) {
              setError("Choose the coordinator from the participants, or none.");
              return;
            }
            if (added && !share) {
              setError(
                "Confirm sharing existing history and project context with the added participants.",
              );
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
                  : "New project"),
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
                  : projectName
                    ? "Conversation title"
                    : "What are we working towards?"
              }
              required={kind === "project" && !projectName}
            />
          </label>
          {kind === "project" && !projectName ? (
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
          {kind === "direct" ? (
            <label>
              Teammate
              <select
                value={facilitator}
                onChange={(event) => {
                  setFacilitator(event.target.value);
                  setIds([event.target.value]);
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
          ) : (
            <>
              <label>
                Coordinator <small>Optional</small>
                <select
                  value={facilitator}
                  onChange={(event) => {
                    const value = event.target.value;
                    setIds((current) => {
                      const retained = current.filter(
                        (id) => id !== facilitator || explicitParticipants.current.has(id),
                      );
                      return value && !retained.includes(value)
                        ? [...retained, value]
                        : retained;
                    });
                    setFacilitator(value);
                  }}
                >
                  <option value="">
                    No coordinator — choose a responder when sending
                  </option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="team-member-picker">
                <legend>
                  Participants <small>Up to eight</small>
                </legend>
                {agents.map((agent) => (
                  <label key={agent.id}>
                    <input
                      type="checkbox"
                      checked={ids.includes(agent.id)}
                      disabled={!ids.includes(agent.id) && ids.length >= 8}
                      onChange={(event) => {
                        if (event.target.checked)
                          explicitParticipants.current.add(agent.id);
                        else explicitParticipants.current.delete(agent.id);
                        if (!event.target.checked && agent.id === facilitator)
                          setFacilitator("");
                        setIds(
                          event.target.checked
                            ? [...ids, agent.id]
                            : ids.filter((id) => id !== agent.id),
                        );
                      }}
                    />
                    <ProfileAgentAvatar agent={agent} iconSize={27} />
                    <span>{agent.name}</span>
                    {agent.id === facilitator ? <small>Coordinator</small> : null}
                  </label>
                ))}
              </fieldset>
              <p className="team-dialog-note">
                Each participant replies with their own saved model and
                instructions through an existing supported route. Without a
                coordinator, the sender explicitly chooses the exact responder
                or addresses one with an @mention. Mivlet never fans out to
                every member automatically.
              </p>
              <TeamReadiness
                participantIds={ids}
                agents={agents}
                models={models}
                providers={providers}
                compact
              />
            </>
          )}
          {kind === "project" && projectName ? (
            <p className="team-dialog-note">
              This conversation belongs to {projectName}. Participants use their
              own saved models; shared Project context and history remain
              available to the team.
            </p>
          ) : kind === "project" ? (
            <p className="team-dialog-note">
              Participants use their own selected models. They receive this
              Project&apos;s shared history, references, decisions and work
              records. Their private conversations remain separate.
            </p>
          ) : null}
          {edit ? (
            <p className="team-dialog-note">
              Changing participants or the coordinator pauses active assignments
              for review. Existing messages keep their original authors.
            </p>
          ) : null}
          {added ? (
            <label className="team-consent">
              <input
                type="checkbox"
                checked={share}
                onChange={(event) => setShare(event.target.checked)}
              />{" "}
              Share existing history and project context with the added
              participants
            </label>
          ) : null}
          {coordinator ? null : kind === "project" ? (
            <p className="team-dialog-note">
              No coordinator is designated. Senders pick a participant or use an
              @mention for each request.
            </p>
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

export interface LegacyGroupMigrationDraft {
  name: string;
  instructions: string;
  participantIds: string[];
  /** Empty when no coordinator is designated. */
  leadAgentId: string;
}

/**
 * Converts a legacy standalone group into its own project. The existing thread,
 * messages and authorship are retained; the dialog only selects the new
 * Project's identity and team.
 */
export function MigrateGroupDialog({
  title,
  agents,
  initialParticipantIds,
  models = [],
  providers = [],
  onMigrate,
  onClose,
}: {
  title: string;
  agents: MivletAgentProfile[];
  initialParticipantIds: string[];
  models?: ProviderModelOption[];
  providers?: BackendProvider[];
  onMigrate: (draft: LegacyGroupMigrationDraft) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(`${title} project`.slice(0, 120));
  const [instructions, setInstructions] = useState("");
  const [ids, setIds] = useState(initialParticipantIds);
  const [lead, setLead] = useState("");
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
          <h2 id={heading}>Convert “{title}” to a project</h2>
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
            if (!ids.length || ids.length > 8) {
              setError("Choose one to eight participants.");
              return;
            }
            if (lead && !ids.includes(lead)) {
              setError("Choose the coordinator from the participants, or none.");
              return;
            }
            if (!share) {
              setError("Confirm sharing the existing history with the project.");
              return;
            }
            setPending(true);
            setError("");
            void onMigrate({
              name: name.trim(),
              instructions,
              participantIds: ids,
              leadAgentId: lead,
            })
              .then(onClose)
              .catch((error) =>
                setError(
                  error instanceof Error
                    ? error.message
                    : "Could not convert this group.",
                ),
              )
              .finally(() => setPending(false));
          }}
        >
          <p>
            The group&apos;s existing conversation, messages and historical
            authorship become this project&apos;s shared Chat. Nothing is
            deleted or replayed.
          </p>
          <label>
            Project name
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              required
            />
          </label>
          <label>
            Instructions <small>Optional</small>
            <textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              rows={3}
              maxLength={6000}
              placeholder="Purpose, constraints, and what a useful result looks like"
            />
          </label>
          <label>
            Coordinator <small>Optional</small>
            <select value={lead} onChange={(event) => setLead(event.target.value)}>
              <option value="">
                No coordinator — choose a responder when sending
              </option>
              {agents
                .filter((agent) => ids.includes(agent.id))
                .map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
            </select>
          </label>
          <fieldset className="team-member-picker">
            <legend>
              Participants <small>Up to eight</small>
            </legend>
            {agents.map((agent) => (
              <label key={agent.id}>
                <input
                  type="checkbox"
                  checked={ids.includes(agent.id)}
                  disabled={!ids.includes(agent.id) && ids.length >= 8}
                  onChange={(event) =>
                    setIds(
                      event.target.checked
                        ? [...ids, agent.id]
                        : ids.filter((id) => id !== agent.id),
                    )
                  }
                />
                <ProfileAgentAvatar agent={agent} iconSize={27} />
                <span>{agent.name}</span>
                {agent.id === lead ? <small>Coordinator</small> : null}
              </label>
            ))}
          </fieldset>
          <TeamReadiness
            participantIds={ids}
            agents={agents}
            models={models}
            providers={providers}
            compact
          />
          <label className="team-consent">
            <input
              type="checkbox"
              checked={share}
              onChange={(event) => setShare(event.target.checked)}
            />{" "}
            Share the existing history and authorship with this project
          </label>
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
              {pending ? "Converting…" : "Convert to project"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

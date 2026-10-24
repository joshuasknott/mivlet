import { useId, useRef, useState } from "react";
import type {
  BackendProvider,
  MivletAgentProfile,
  ProjectSourceFolderImport,
} from "@mivlet/protocol";
import { CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { Folder } from "@phosphor-icons/react/dist/csr/Folder";
import { FolderPlus } from "@phosphor-icons/react/dist/csr/FolderPlus";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import type { ProviderModelOption } from "../../lib/provider-models";
import { ProfileAgentAvatar } from "../agents/agent-icons";
import type { ConversationDraft } from "./conversation-draft";
import { TeamReadiness } from "./TeamReadiness";
import "./new-project-dialog.css";

export function NewProjectDialog({
  agents,
  models = [],
  providers = [],
  initial,
  onImportSourceFolder,
  onSave,
  onClose,
}: {
  agents: MivletAgentProfile[];
  models?: ProviderModelOption[];
  providers?: BackendProvider[];
  initial?: Partial<ConversationDraft>;
  onImportSourceFolder?: () => Promise<ProjectSourceFolderImport | null>;
  onSave: (draft: ConversationDraft) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [ids, setIds] = useState(
    initial?.participantIds ?? agents.slice(0, 1).map((agent) => agent.id),
  );
  const [facilitator, setFacilitator] = useState(initial?.facilitatorId ?? "");
  const explicitParticipants = useRef(new Set(ids));
  const [folders, setFolders] = useState<ProjectSourceFolderImport[]>([]);
  const [pending, setPending] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLDetailsElement>(null);
  const folderButton = useRef<HTMLButtonElement>(null);
  const heading = useId();
  const busy = pending || picking;
  useModalFocusTrap({
    active: true,
    containerRef: panel,
    onClose: () => {
      if (!busy) onClose();
    },
  });

  const selectAgent = (id: string, selected: boolean) => {
    if (selected && ids.length >= 8) return;
    if (selected) explicitParticipants.current.add(id);
    else {
      explicitParticipants.current.delete(id);
      if (facilitator === id) setFacilitator("");
    }
    setIds(selected ? [...ids, id] : ids.filter((entry) => entry !== id));
  };
  const importFolder = async () => {
    setPicking(true);
    setError("");
    try {
      if (!onImportSourceFolder)
        throw new Error("Open the desktop app to add a source folder.");
      const folder = await onImportSourceFolder();
      if (folder) {
        const next = [
          ...folders.filter((entry) => entry.id !== folder.id),
          folder,
        ];
        const sourceIds = new Set([
          ...(initial?.knowledgeSourceIds ?? []),
          ...next.flatMap((entry) => entry.sources.map((source) => source.id)),
        ]);
        if (sourceIds.size > 64)
          throw new Error(
            "A project can include up to 64 source files. Choose a smaller folder.",
          );
        setFolders(next);
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not add this folder.",
      );
    } finally {
      setPicking(false);
      requestAnimationFrame(() => folderButton.current?.focus());
    }
  };

  return (
    <div className="modal-backdrop team-dialog-backdrop project-create-backdrop">
      <div
        className="team-dialog project-create"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={heading}
      >
        <header>
          <h2 id={heading}>New project</h2>
          <button
            type="button"
            disabled={busy}
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            if (
              !ids.length ||
              ids.length > 8 ||
              ids.some((id) => !agents.some((agent) => agent.id === id))
            ) {
              setError("Choose one to eight agents.");
              picker.current?.setAttribute("open", "");
              return;
            }
            if (facilitator && !ids.includes(facilitator)) {
              setError(
                "Choose a coordinator from the selected agents, or none.",
              );
              return;
            }
            setPending(true);
            setError("");
            void onSave({
              kind: "project",
              title: title.trim(),
              instructions,
              participantIds: ids,
              facilitatorId: facilitator,
              shareHistory: false,
              knowledgeSourceIds: [
                ...new Set([
                  ...(initial?.knowledgeSourceIds ?? []),
                  ...folders.flatMap((folder) =>
                    folder.sources.map((source) => source.id),
                  ),
                ]),
              ],
            })
              .then(onClose)
              .catch((cause) =>
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Could not create this project.",
                ),
              )
              .finally(() => setPending(false));
          }}
        >
          <fieldset disabled={busy} className="project-create__fields">
            <label className="project-create__field">
              Name
              <input
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={120}
                placeholder="Project name"
                required
                pattern=".*\S.*"
              />
            </label>
            <section
              className="project-create__field"
              aria-label="Source folders"
            >
              <h3>Source folders</h3>
              {folders.length > 0 && (
                <ul className="project-create__folders">
                  {folders.map((folder) => (
                    <li key={folder.id}>
                      <Folder size={18} aria-hidden="true" />
                      <span>
                        <strong>{folder.name}</strong>
                        <small>
                          {folder.sources.length} file
                          {folder.sources.length === 1 ? "" : "s"} imported
                          {folder.skippedCount
                            ? ` · ${folder.skippedCount} skipped`
                            : ""}
                        </small>
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove folder ${folder.name}`}
                        onClick={() => {
                          setFolders((current) =>
                            current.filter((entry) => entry.id !== folder.id),
                          );
                          folderButton.current?.focus();
                        }}
                      >
                        <X size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="project-create__folder-add">
                <span>Add a folder on this computer</span>
                <button
                  ref={folderButton}
                  type="button"
                  aria-label="Add source folder"
                  onClick={() => void importFolder()}
                >
                  <FolderPlus size={17} aria-hidden="true" />
                  {picking ? "Adding…" : "Add"}
                </button>
              </div>
            </section>
            <label className="project-create__field">
              <span>
                Instructions <small>Optional</small>
              </span>
              <textarea
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                rows={2}
                maxLength={6000}
                placeholder="What should your agents know?"
              />
            </label>
            <section className="project-create__field" aria-label="Agents">
              <h3>Agents</h3>
              <div className="project-create__agents">
                {ids
                  .map((id) => agents.find((agent) => agent.id === id))
                  .filter((agent) => !!agent)
                  .map((agent) => (
                    <span className="project-create__agent" key={agent.id}>
                      <ProfileAgentAvatar agent={agent} iconSize={24} />
                      <span>{agent.name}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${agent.name}`}
                        onClick={() => {
                          selectAgent(agent.id, false);
                          picker.current?.querySelector("summary")?.focus();
                        }}
                      >
                        <X size={15} />
                      </button>
                    </span>
                  ))}
                <details
                  ref={picker}
                  className="project-create__agent-picker"
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && picker.current?.open) {
                      event.preventDefault();
                      event.stopPropagation();
                      picker.current.open = false;
                      picker.current.querySelector("summary")?.focus();
                    }
                  }}
                >
                  <summary aria-label="Add agents">
                    <Plus size={18} aria-hidden="true" />
                    Add
                  </summary>
                  <div
                    className="project-create__agent-options"
                    role="group"
                    aria-label="Choose agents"
                  >
                    {agents.length ? (
                      agents.map((agent) => (
                        <label key={agent.id}>
                          <input
                            type="checkbox"
                            checked={ids.includes(agent.id)}
                            disabled={
                              !ids.includes(agent.id) && ids.length >= 8
                            }
                            onChange={(event) =>
                              selectAgent(agent.id, event.target.checked)
                            }
                          />
                          <ProfileAgentAvatar agent={agent} iconSize={24} />
                          <span>{agent.name}</span>
                        </label>
                      ))
                    ) : (
                      <p>No agents available.</p>
                    )}
                  </div>
                </details>
              </div>
            </section>
            <details className="project-create__more">
              <summary>
                <CaretRight size={18} aria-hidden="true" />
                More options
              </summary>
              <div>
                <label className="project-create__field">
                  <span>
                    Coordinator <small>Optional</small>
                  </span>
                  <select
                    value={facilitator}
                    onChange={(event) => {
                      const value = event.target.value;
                      const retained = ids.filter(
                        (id) =>
                          id !== facilitator ||
                          explicitParticipants.current.has(id),
                      );
                      const next =
                        value && !retained.includes(value)
                          ? [...retained, value]
                          : retained;
                      if (next.length > 8) {
                        setError("Choose one to eight agents.");
                        return;
                      }
                      setIds(next);
                      setFacilitator(value);
                    }}
                  >
                    <option value="">None</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                </label>
                <TeamReadiness
                  participantIds={ids}
                  agents={agents}
                  models={models}
                  providers={providers}
                  compact
                />
              </div>
            </details>
          </fieldset>
          {error && <p role="alert">{error}</p>}
          <footer>
            <button
              type="submit"
              className="button button-primary"
              disabled={busy}
            >
              {pending ? "Creating…" : "Create project"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

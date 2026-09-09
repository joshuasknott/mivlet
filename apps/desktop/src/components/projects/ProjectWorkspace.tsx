import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { Check } from "@phosphor-icons/react/dist/csr/Check";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { FolderSimple } from "@phosphor-icons/react/dist/csr/FolderSimple";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { Trash } from "@phosphor-icons/react/dist/csr/Trash";
import { UsersThree } from "@phosphor-icons/react/dist/csr/UsersThree";
import { X } from "@phosphor-icons/react/dist/csr/X";
import type { FableAgentProfile } from "@fable/protocol";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { ProfileAgentAvatar } from "../agents/agent-icons";
import "./projects.css";

export type ProjectTab = "conversation" | "files" | "instructions";

export interface ProjectFileItem {
  sourceId: string;
  name: string;
  mediaType?: string;
  sizeBytes?: number;
  provenance?: string;
}

export interface ProjectDraft {
  name: string;
  instructions: string;
}

function matchesArrowKey(key: string) {
  return ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"].includes(key);
}

const PROJECT_TABS: readonly { id: ProjectTab; label: string }[] = [
  { id: "conversation", label: "Conversation" },
  { id: "files", label: "Files" },
  { id: "instructions", label: "Instructions" },
];

export function ProjectHeader({
  name,
  activeTab,
  onTabChange,
  onBack,
  actions,
}: {
  name: string;
  activeTab: ProjectTab;
  onTabChange: (tab: ProjectTab) => void;
  onBack?: () => void;
  actions?: ReactNode;
}) {
  return (
    <header className="project-header">
      <div className="project-header__identity">
        {onBack ? (
          <button
            className="project-header__back"
            type="button"
            onClick={onBack}
            aria-label="Back to projects"
          >
            <ArrowLeft size={19} aria-hidden="true" />
          </button>
        ) : null}
        <span className="project-header__icon" aria-hidden="true">
          <FolderSimple size={25} />
        </span>
        <span className="project-header__copy">
          <strong>{name}</strong>
          <small>Shared with all agents</small>
        </span>
        {actions ? (
          <span className="project-header__actions">{actions}</span>
        ) : null}
      </div>
      <nav className="project-tabs" aria-label={`${name} sections`}>
        {PROJECT_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-current={activeTab === tab.id ? "page" : undefined}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
    </header>
  );
}

export function ProjectParticipants({
  agents,
  recipientAgentId,
  onSelect,
  disabled = false,
}: {
  agents: FableAgentProfile[];
  recipientAgentId: string | null;
  onSelect: (agentId: string | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const selected = agents.find((agent) => agent.id === recipientAgentId);
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? agents.filter((agent) => agent.name.toLowerCase().includes(normalized))
      : agents;
  }, [agents, query]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      if (agents.length <= 6) {
        panel.current
          ?.querySelector<HTMLButtonElement>('[role="option"]')
          ?.focus();
      }
    });
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="project-participants" ref={root}>
      <button
        ref={trigger}
        className="project-participants__trigger"
        type="button"
        disabled={disabled || agents.length === 0}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {selected ? (
          <ProfileAgentAvatar agent={selected} iconSize={21} />
        ) : (
          <UsersThree size={20} aria-hidden="true" />
        )}
        <span>{selected?.name ?? "All agents"}</span>
        <CaretDown size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div
          ref={panel}
          className="project-participants__panel"
          role="dialog"
          aria-label="Choose who should answer"
        >
          {agents.length > 6 ? (
            <label className="project-picker-search">
              <MagnifyingGlass size={15} aria-hidden="true" />
              <input
                autoFocus
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find an agent"
                aria-label="Find an agent"
              />
            </label>
          ) : null}
          <div
            className="project-participants__options"
            role="listbox"
            aria-label="Project recipients"
            onKeyDown={(event) => {
              if (!matchesArrowKey(event.key)) return;
              const options = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role="option"]:not([disabled])',
                ),
              );
              if (!options.length) return;
              const current = options.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const next =
                event.key === "ArrowDown" || event.key === "ArrowRight"
                  ? (current + 1 + options.length) % options.length
                  : (current - 1 + options.length) % options.length;
              event.preventDefault();
              options[next]?.focus();
            }}
          >
            <button
              type="button"
              role="option"
              aria-selected={recipientAgentId === null}
              onClick={() => {
                onSelect(null);
                setOpen(false);
              }}
            >
              <span className="project-participants__all">
                <UsersThree size={18} aria-hidden="true" />
              </span>
              <span>
                <strong>All agents</strong>
                <small>Invite every agent to contribute</small>
              </span>
              {recipientAgentId === null ? (
                <Check size={15} aria-hidden="true" />
              ) : null}
            </button>
            {visible.map((agent) => (
              <button
                key={agent.id}
                type="button"
                role="option"
                aria-selected={recipientAgentId === agent.id}
                onClick={() => {
                  onSelect(agent.id);
                  setOpen(false);
                }}
              >
                <ProfileAgentAvatar agent={agent} iconSize={27} />
                <span>
                  <strong>{agent.name}</strong>
                  <small>{agent.instructions || "Project agent"}</small>
                </span>
                {recipientAgentId === agent.id ? (
                  <Check size={15} aria-hidden="true" />
                ) : null}
              </button>
            ))}
            {visible.length === 0 ? (
              <p role="status">No agents match “{query}”.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatBytes(bytes?: number) {
  if (bytes === undefined) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ProjectFiles({
  files,
  eligibleSources,
  onAttach,
  onRemove,
  onImport,
  onOpen,
  compact = false,
  disabled = false,
  error,
  status,
}: {
  files: ProjectFileItem[];
  eligibleSources: ProjectFileItem[];
  onAttach: (sourceId: string) => void;
  onRemove: (sourceId: string) => void;
  onImport?: () => void;
  onOpen?: (sourceId: string) => void;
  compact?: boolean;
  disabled?: boolean;
  error?: string | null;
  status?: string | null;
}) {
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const attachedIds = useMemo(
    () => new Set(files.map((file) => file.sourceId)),
    [files],
  );
  const choices = eligibleSources.filter((source) => {
    if (attachedIds.has(source.sourceId)) return false;
    return source.name.toLowerCase().includes(query.trim().toLowerCase());
  });
  return (
    <section
      className={`project-files${compact ? " project-files--compact" : ""}`}
      aria-labelledby={compact ? undefined : "project-files-title"}
    >
      <header>
        <div>
          <h2 id={compact ? undefined : "project-files-title"}>
            {compact ? "Files" : "Project files"}
          </h2>
          {!compact ? (
            <p>Shared references and results available to this project.</p>
          ) : null}
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setAdding((value) => !value)}
          aria-label="Add project file"
          aria-expanded={adding}
        >
          <Plus size={17} aria-hidden="true" />
          {compact ? null : <span>Add file</span>}
        </button>
      </header>
      {adding ? (
        <div className="project-files__picker">
          {eligibleSources.length > 6 ? (
            <label className="project-picker-search">
              <MagnifyingGlass size={15} aria-hidden="true" />
              <input
                autoFocus
                type="search"
                placeholder="Find an imported file"
                aria-label="Find an imported file"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          ) : null}
          <div className="project-files__choices">
            {choices.map((source) => (
              <button
                type="button"
                disabled={disabled}
                key={source.sourceId}
                onClick={() => {
                  onAttach(source.sourceId);
                  setAdding(false);
                }}
              >
                <FileText size={18} aria-hidden="true" />
                <span>
                  <strong>{source.name}</strong>
                  <small>
                    {source.provenance ?? source.mediaType ?? "Imported file"}
                  </small>
                </span>
              </button>
            ))}
            {choices.length === 0 ? (
              <p>
                {eligibleSources.length
                  ? "All matching files are already attached."
                  : "No imported files are available."}
              </p>
            ) : null}
          </div>
          {onImport ? (
            <button
              className="project-files__import"
              type="button"
              disabled={disabled}
              onClick={onImport}
            >
              <Plus size={15} aria-hidden="true" />
              Import from computer
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p
          className="project-form-message project-form-message--error"
          role="alert"
        >
          {error}
        </p>
      ) : status ? (
        <p className="project-form-message" role="status">
          {status}
        </p>
      ) : null}
      <div className="project-files__list">
        {files.map((file) => {
          const size = formatBytes(file.sizeBytes);
          return (
            <div className="project-file" key={file.sourceId}>
              <FileText size={compact ? 20 : 23} aria-hidden="true" />
              {onOpen ? (
                <button
                  className="project-file__open"
                  type="button"
                  disabled={disabled}
                  onClick={() => onOpen(file.sourceId)}
                >
                  <strong>{file.name}</strong>
                  <small>
                    {[file.mediaType?.split("/").at(-1)?.toUpperCase(), size]
                      .filter(Boolean)
                      .join(" · ") ||
                      file.provenance ||
                      "Shared file"}
                  </small>
                </button>
              ) : (
                <span>
                  <strong>{file.name}</strong>
                  <small>
                    {[file.mediaType?.split("/").at(-1)?.toUpperCase(), size]
                      .filter(Boolean)
                      .join(" · ") ||
                      file.provenance ||
                      "Shared file"}
                  </small>
                </span>
              )}
              <button
                type="button"
                disabled={disabled}
                onClick={() => onRemove(file.sourceId)}
                aria-label={`Remove ${file.name} from project`}
              >
                <Trash size={15} aria-hidden="true" />
              </button>
            </div>
          );
        })}
        {files.length === 0 ? (
          <p className="project-files__empty">
            No files have been added to this project.
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function ProjectInstructions({
  instructions,
  onSave,
  pending = false,
  error,
  status,
}: {
  instructions: string;
  onSave: (instructions: string) => void | Promise<void>;
  pending?: boolean;
  error?: string | null;
  status?: string | null;
}) {
  const [draft, setDraft] = useState(instructions);
  useEffect(() => setDraft(instructions), [instructions]);
  return (
    <form
      className="project-instructions"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) void onSave(draft.trim());
      }}
    >
      <div>
        <h2>Project instructions</h2>
        <p>
          Give every agent the same goals, constraints, and working context.
        </p>
      </div>
      <label>
        <span>Instructions</span>
        <textarea
          disabled={pending}
          rows={9}
          maxLength={12000}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="What should agents know when working in this project?"
        />
      </label>
      {error ? (
        <p
          className="project-form-message project-form-message--error"
          role="alert"
        >
          {error}
        </p>
      ) : status ? (
        <p className="project-form-message" role="status">
          {status}
        </p>
      ) : null}
      <footer>
        <small>{draft.length.toLocaleString()} / 12,000</small>
        <button
          type="submit"
          disabled={pending || draft.trim() === instructions.trim()}
        >
          {pending ? "Saving…" : "Save instructions"}
        </button>
      </footer>
    </form>
  );
}

export function ProjectWorkspace({
  name,
  activeTab,
  onTabChange,
  onBack,
  headerActions,
  conversation,
  files,
  instructions,
  rail,
}: {
  name: string;
  activeTab: ProjectTab;
  onTabChange: (tab: ProjectTab) => void;
  onBack?: () => void;
  headerActions?: ReactNode;
  conversation: ReactNode;
  files: ReactNode;
  instructions: ReactNode;
  rail?: ReactNode;
}) {
  const content =
    activeTab === "conversation"
      ? conversation
      : activeTab === "files"
        ? files
        : instructions;
  return (
    <section
      className={`project-workspace${rail ? " project-workspace--with-rail" : ""}`}
    >
      <ProjectHeader
        name={name}
        activeTab={activeTab}
        onTabChange={onTabChange}
        onBack={onBack}
        actions={headerActions}
      />
      <div className="project-workspace__content">{content}</div>
      {rail ? (
        <aside className="project-workspace__rail" aria-label="Project details">
          {rail}
        </aside>
      ) : null}
    </section>
  );
}

export function ProjectEditor({
  open,
  project,
  onClose,
  onSave,
  onArchive,
  pending = false,
  error,
}: {
  open: boolean;
  project: ({ id: string } & ProjectDraft) | null;
  onClose: () => void;
  onSave: (draft: ProjectDraft) => void | Promise<void>;
  onArchive?: (projectId: string) => void | Promise<void>;
  pending?: boolean;
  error?: string | null;
}) {
  const [draft, setDraft] = useState<ProjectDraft>({
    name: "",
    instructions: "",
  });
  const modal = useRef<HTMLDivElement>(null);
  const name = useRef<HTMLInputElement>(null);
  useModalFocusTrap({
    active: open,
    containerRef: modal,
    initialFocusRef: name,
    onClose: pending ? undefined : onClose,
  });
  useEffect(() => {
    if (open)
      setDraft(
        project
          ? { name: project.name, instructions: project.instructions }
          : { name: "", instructions: "" },
      );
  }, [open, project?.id]);
  if (!open) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!pending && draft.name.trim())
      void onSave({
        name: draft.name.trim(),
        instructions: draft.instructions.trim(),
      });
  };
  return (
    <div className="project-editor-backdrop" role="presentation">
      <section
        className="project-editor"
        ref={modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-editor-title"
        aria-busy={pending}
        tabIndex={-1}
      >
        <header>
          <div className="project-editor__mark">
            <FolderSimple size={22} aria-hidden="true" />
          </div>
          <div>
            <h2 id="project-editor-title">
              {project ? "Edit project" : "Create project"}
            </h2>
            <p>
              Projects give every agent one shared conversation and context.
            </p>
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={onClose}
            aria-label="Close project editor"
          >
            <X size={18} />
          </button>
        </header>
        <form onSubmit={submit}>
          <label>
            <span>Name</span>
            <input
              disabled={pending}
              ref={name}
              required
              maxLength={120}
              value={draft.name}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
              placeholder="Website launch"
            />
          </label>
          <label>
            <span>
              Instructions <small>Optional</small>
            </span>
            <textarea
              disabled={pending}
              rows={5}
              maxLength={12000}
              value={draft.instructions}
              onChange={(event) =>
                setDraft({ ...draft, instructions: event.target.value })
              }
              placeholder="What should agents know about this project?"
            />
          </label>
          <p className="project-editor__sharing">
            <UsersThree size={17} aria-hidden="true" />
            <span>
              <strong>Shared with all agents</strong>
              <small>
                Every agent can see the project conversation, files, and
                instructions.
              </small>
            </span>
          </p>
          {error ? (
            <p
              className="project-form-message project-form-message--error"
              role="alert"
            >
              {error}
            </p>
          ) : null}
          <footer>
            {project && onArchive ? (
              <button
                disabled={pending}
                className="project-editor__delete"
                type="button"
                onClick={() => void onArchive(project.id)}
              >
                <Trash size={15} aria-hidden="true" />
                Archive
              </button>
            ) : (
              <span />
            )}
            <div>
              <button type="button" disabled={pending} onClick={onClose}>
                Cancel
              </button>
              <button
                className="project-editor__save"
                type="submit"
                disabled={pending || !draft.name.trim()}
              >
                {pending
                  ? "Saving…"
                  : project
                    ? "Save changes"
                    : "Create project"}
              </button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}

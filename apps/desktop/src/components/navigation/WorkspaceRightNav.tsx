import { useRef, useState, type ReactNode } from "react";
import type {
  CollaborationWorkItem,
  ConversationRoom,
  FableAgentProfile,
  LocalProject,
} from "@fable/protocol";
import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { Desktop } from "@phosphor-icons/react/dist/csr/Desktop";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import type { WorkspaceExecution } from "../../lib/workspace-execution";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { WorkItems } from "../projects/WorkItems";
import { ProfileAgentAvatar } from "../agents/agent-icons";
import { PRESENCE_LABELS, type AgentPresence } from "../../lib/agent-presence";
import { attentionOrder, needsAttention } from "./work-order";

/** The selected Agent or Project that owns the nav's sections. */
export type NavContext =
  | { kind: "agent"; agent: FableAgentProfile }
  | { kind: "project"; project: LocalProject }
  | null;

/** Side Chats stay subordinate: proven side chats plus unclassified private rooms. */
export function sideChatsFor(
  context: NavContext,
  rooms: ConversationRoom[],
): ConversationRoom[] {
  if (!context) return [];
  return rooms.filter((room) => {
    if (context.kind === "agent") {
      const agent = context.agent;
      if (room.chat)
        return (
          room.chat.role === "side" &&
          room.chat.ownerKind === "agent" &&
          room.chat.ownerId === agent.id
        );
      return (
        !room.projectId &&
        room.kind === "direct" &&
        room.participants.some((member) => member.agentId === agent.id)
      );
    }
    return (
      room.projectId === context.project.id &&
      (!room.chat || room.chat.role === "side")
    );
  });
}

function NavSection({
  title,
  count,
  children,
  open = true,
}: {
  title: string;
  count?: number;
  children: ReactNode;
  open?: boolean;
}) {
  const [expanded, setExpanded] = useState(open);
  return (
    <section className="workspace-context__section" aria-label={title}>
      <h3>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {title}
          {count !== undefined ? <small>{count}</small> : null}
        </button>
      </h3>
      {expanded ? <div className="workspace-context__body">{children}</div> : null}
    </section>
  );
}

/**
 * The one contextual right panel. It replaces the separate history, details
 * and computer panels: sections follow the selected Agent or Project, and the
 * agent computer renders here as a mode of this same panel. Closing it never
 * affects running work.
 */
export function WorkspaceRightNav({
  context,
  rooms,
  work,
  runtime,
  service,
  open,
  onClose,
  onOpenConversation,
  onNewSideChat,
  onSchedules,
  onOpenComputer,
  computerAgentId,
  computer,
  onCloseComputer,
  onManageMemory,
  onEditProject,
  presence = "idle",
  activity,
  projectDetails,
}: {
  context: NavContext;
  rooms: ConversationRoom[];
  work: CollaborationWorkItem[];
  runtime: ShellRuntime;
  service: WorkspaceExecution;
  open: boolean;
  onClose: () => void;
  onOpenConversation: (id: string, newTab?: boolean) => void;
  onNewSideChat?: () => void;
  onSchedules?: () => void;
  onOpenComputer?: (agentId: string) => void;
  computerAgentId?: string | null;
  computer?: ReactNode;
  onCloseComputer?: () => void;
  onManageMemory?: () => void;
  onEditProject?: () => void;
  presence?: AgentPresence;
  activity?: string;
  projectDetails?: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const compact = useMediaQuery("(max-width: 850px)");
  useModalFocusTrap({ active: open && compact, containerRef: panel, onClose });
  const attention = work.filter(needsAttention);
  const agent = context?.kind === "agent" ? context.agent : null;
  const project = context?.kind === "project" ? context.project : null;
  const contextWork = agent
    ? work.filter((item) => item.agentId === agent.id)
    : work;
  const chats = sideChatsFor(context, rooms);
  const memory = (runtime.managedMemoryRecords ?? []).filter(
    (record) => !record.forgottenAt,
  );
  return (
    <aside
      ref={panel}
      className="workspace-context"
      aria-label="Context"
      role={compact ? "dialog" : undefined}
      aria-modal={compact || undefined}
      hidden={!open}
    >
      <header className="workspace-context__header">
        {computerAgentId ? (
          <button
            type="button"
            className="workspace-context__back"
            onClick={() => onCloseComputer?.()}
          >
            <ArrowLeft size={16} aria-hidden="true" />
            Back to context
          </button>
        ) : (
          <span className="workspace-context__identity">
            {agent ? (
              <>
                <ProfileAgentAvatar agent={agent} iconSize={24} presence={presence} />
                <strong>{agent.name}</strong>
                <small role="status" data-presence={presence}>
                  {PRESENCE_LABELS[presence]}
                  {presence === "working" && activity ? ` · ${activity}` : ""}
                </small>
              </>
            ) : (
              <strong>{project ? project.name : "Workspace"}</strong>
            )}
          </span>
        )}
        {attention.length ? (
          <button
            type="button"
            className="workspace-context__attention"
            aria-label={`${attention.length} work ${attention.length === 1 ? "item needs" : "items need"} attention`}
            onClick={() => onOpenConversation(attention[0].conversationId)}
            title={`${attention[0].agentName}: ${attention[0].status.replaceAll("-", " ")}`}
          >
            {attention.length}
          </button>
        ) : null}
        <button
          type="button"
          className="workspace-context__close"
          aria-label="Close context panel"
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </header>
      {computerAgentId ? (
        <div className="workspace-context__computer">{computer}</div>
      ) : (
        <div className="workspace-context__sections">
          {attention.length ? (
            <div className="workspace-context__pinned">
              <h3>Work needing attention</h3>
              {attention.slice(0, 4).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onOpenConversation(item.conversationId)}
                >
                  <strong>{item.agentName}</strong>
                  <small>{item.status.replaceAll("-", " ")}</small>
                </button>
              ))}
            </div>
          ) : null}
          {context ? (
            <NavSection title="Side Chats" count={chats.length}>
              {onNewSideChat ? (
                <button
                  type="button"
                  className="workspace-context__row workspace-context__row--action"
                  onClick={onNewSideChat}
                >
                  <Plus size={13} aria-hidden="true" />
                  New side chat
                </button>
              ) : null}
              {chats.map((room) => (
                <button
                  key={room.id}
                  type="button"
                  className="workspace-context__row"
                  title={room.title}
                  onClick={(event) =>
                    onOpenConversation(room.id, event.ctrlKey || event.metaKey)
                  }
                >
                  {room.title}
                </button>
              ))}
              {!chats.length && !onNewSideChat ? (
                <p className="workspace-context__empty">
                  Side chats will appear here.
                </p>
              ) : null}
            </NavSection>
          ) : null}
          {project ? (
            <NavSection title="Project" open={false}>
              {projectDetails}
            </NavSection>
          ) : (
            <NavSection title="Work" count={contextWork.length}>
              <WorkItems
                work={attentionOrder(contextWork)}
                service={service}
                onOpen={onOpenConversation}
              />
            </NavSection>
          )}
          {onSchedules ? (
            <button
              type="button"
              className="workspace-context__row workspace-context__row--action"
              onClick={onSchedules}
            >
              <Clock size={14} aria-hidden="true" />
              View schedules
            </button>
          ) : null}
          {project && onEditProject ? (
            <button
              type="button"
              className="workspace-context__row workspace-context__row--action"
              onClick={onEditProject}
            >
              Edit project
            </button>
          ) : null}
          {agent ? (
            <>
              <NavSection title="Memory" count={memory.length} open={false}>
                <p className="workspace-context__empty">
                  {memory.length
                    ? `${memory.length} in scope for this agent.`
                    : "No memory records are saved yet."}
                </p>
                {onManageMemory ? (
                  <button
                    type="button"
                    className="workspace-context__row workspace-context__row--action"
                    onClick={onManageMemory}
                  >
                    Manage memory in Settings
                  </button>
                ) : null}
              </NavSection>
              {onOpenComputer ? (
                <NavSection title="Computer" open={false}>
                  <button
                    type="button"
                    className="workspace-context__row workspace-context__row--action"
                    onClick={() => onOpenComputer(agent.id)}
                  >
                    <Desktop size={15} aria-hidden="true" />
                    {agent.name}'s computer
                  </button>
                </NavSection>
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </aside>
  );
}

import { useRef, useState, type ReactNode } from "react";
import type {
  ApprovalRequest,
  CollaborationWorkItem,
  ConversationRoom,
  FableAgentProfile,
  LocalProject,
  ProjectTeam,
  WorkOutput,
} from "@fable/protocol";
import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { Desktop } from "@phosphor-icons/react/dist/csr/Desktop";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { WorkList } from "../work/WorkCard";
import { WorkDetails } from "../work/WorkDetails";
import { WorkStatusBadge } from "../work/WorkStatusBadge";
import "../work/work.css";
import "./navigation.css";
import { ProfileAgentAvatar } from "../agents/agent-icons";
import { PRESENCE_LABELS, type AgentPresence } from "../../lib/agent-presence";
import {
  attentionOrder,
  memoryInScope,
  needsAttention,
  scopeLevelsFor,
  scopedRoomIds,
  sideChatsFor,
  teamMembers,
} from "./work-order";

/** The selected context the nav describes: an Agent, a Project, or one Work
 * item inside either. It never fabricates a Project that has not loaded. */
export type NavContext =
  | { kind: "agent"; agent: FableAgentProfile }
  | { kind: "project"; project: LocalProject }
  | { kind: "work"; item: CollaborationWorkItem }
  | null;

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
 * and computer panels: sections follow the selected Agent, Project or Work
 * item, and the agent computer renders here as a mode of this same panel.
 * Closing it never affects running work.
 */
export function WorkspaceRightNav({
  context,
  rooms,
  work,
  team,
  runtime,
  approvals = [],
  open,
  onClose,
  onOpenConversation,
  onOpenWork,
  onStopWork,
  onContinueWork,
  onSteerWork,
  onPromoteWorkOutput,
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
  sideChats,
  summaries,
}: {
  context: NavContext;
  rooms: ConversationRoom[];
  work: CollaborationWorkItem[];
  team?: ProjectTeam;
  runtime: ShellRuntime;
  approvals?: ApprovalRequest[];
  open: boolean;
  onClose: () => void;
  onOpenConversation: (id: string, newTab?: boolean) => void;
  onOpenWork?: (id: string | null) => void;
  onStopWork?: (id: string) => void | Promise<void>;
  onContinueWork?: (
    id: string,
    expectedGeneration: number,
  ) => void | Promise<void>;
  onSteerWork?: (
    id: string,
    expectedGeneration: number,
    text: string,
  ) => void | Promise<void>;
  onPromoteWorkOutput?: (
    output: WorkOutput,
    item: CollaborationWorkItem,
    value: string,
  ) => void | Promise<void>;
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
  sideChats?: ReactNode;
  summaries?: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const compact = useMediaQuery("(max-width: 850px)");
  useModalFocusTrap({ active: open && compact, containerRef: panel, onClose });
  const agent =
    context?.kind === "agent"
      ? context.agent
      : context?.kind === "work"
        ? runtime.agents.find((item) => item.id === context.item.agentId)
        : null;
  const project = context?.kind === "project" ? context.project : null;
  const item = context?.kind === "work" ? context.item : null;
  const contextWork = item
    ? [item]
    : project
      ? work.filter((entry) => entry.projectId === project.id)
      : agent
        ? work.filter((entry) => entry.agentId === agent.id)
        : work;
  const attention = attentionOrder(contextWork).filter(needsAttention);
  const chats = sideChatsFor(
    agent
      ? { kind: "agent", agentId: agent.id }
      : project
        ? { kind: "project", project }
        : null,
    rooms,
  );
  const scopes = scopeLevelsFor({
    agentId: agent?.id,
    projectId: project?.id,
    roomIds: scopedRoomIds(agent?.id, project?.id, rooms),
    workIds: contextWork.map((entry) => entry.id),
  });
  const memory = (runtime.managedMemoryRecords ?? []).filter(
    (record) => !record.forgottenAt && memoryInScope(record, scopes),
  );
  const members = project ? teamMembers(team, runtime.agents) : null;
  const contextApprovals = approvals;
  const contextTools = runtime.connectorManifests.filter(
    (connector) => connector.status === "connected" && connector.id !== "local-files",
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
        ) : item ? (
          <>
            <button
              type="button"
              className="workspace-context__back"
              onClick={() => onOpenWork?.(null)}
            >
              <ArrowLeft size={16} aria-hidden="true" />
              Back to context
            </button>
            <WorkStatusBadge item={item} />
          </>
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
          {item ? (
            <div className="workspace-context__work">
              <WorkDetails
                item={item}
                onOpen={onOpenConversation}
                onStop={(id) => onStopWork?.(id)}
                onContinue={(id, generation) =>
                  onContinueWork?.(id, generation)
                }
                onSteer={(id, generation, text) =>
                  onSteerWork?.(id, generation, text)
                }
                onPromote={onPromoteWorkOutput}
              />
            </div>
          ) : null}
          {!item && attention.length ? (
            <div className="workspace-context__pinned">
              <h3>Work needing attention</h3>
              {attention.slice(0, 4).map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() =>
                    onOpenWork
                      ? onOpenWork(entry.id)
                      : onOpenConversation(entry.conversationId)
                  }
                >
                  <strong>{entry.agentName}</strong>
                  <small>{entry.status.replaceAll("-", " ")}</small>
                </button>
              ))}
            </div>
          ) : null}
          {summaries}
          {sideChats ?? (!item && context ? (
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
                  aria-current={false}
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
          ) : null)}
          {!item && project && members ? (
            <NavSection title="Team" count={members.participants.length} open={false}>
              {members.lead ? (
                <p className="workspace-context__empty">
                  Lead: {members.lead}
                </p>
              ) : null}
              {members.participants.map((name) => (
                <p key={name} className="workspace-context__empty">
                  {name}
                </p>
              ))}
            </NavSection>
          ) : null}
          {!item ? (
            <NavSection title="Work" count={contextWork.length}>
              <WorkList
                work={attentionOrder(contextWork)}
                empty="Assignments and their results appear here when work starts."
                onOpen={onOpenConversation}
                onOpenWork={onOpenWork}
                onStop={(id) => onStopWork?.(id)}
                onContinue={(id, generation) =>
                  onContinueWork?.(id, generation)
                }
                onSteer={(id, generation, text) =>
                  onSteerWork?.(id, generation, text)
                }
              />
            </NavSection>
          ) : null}
          {!item && project ? (
            <NavSection title="Project" open={false}>
              {projectDetails}
            </NavSection>
          ) : null}
          {!item && contextApprovals.length ? (
            <NavSection
              title="Approvals"
              count={contextApprovals.length}
              open={false}
            >
              {contextApprovals.slice(0, 4).map((approval) => (
                <p key={approval.id} className="workspace-context__empty">
                  {approval.action}
                </p>
              ))}
            </NavSection>
          ) : null}
          {!item && contextTools.length ? (
            <NavSection title="Tools" count={contextTools.length} open={false}>
              {contextTools.map((connector) => (
                <p key={connector.id} className="workspace-context__empty">
                  {connector.name}
                </p>
              ))}
            </NavSection>
          ) : null}
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
          {!item && project && onEditProject ? (
            <button
              type="button"
              className="workspace-context__row workspace-context__row--action"
              onClick={onEditProject}
            >
              Edit project
            </button>
          ) : null}
          {!item && agent ? (
            <>
              <NavSection title="Memory" count={memory.length} open={false}>
                <p className="workspace-context__empty">
                  {memory.length
                    ? `${memory.length} in scope for this agent.`
                    : "No memory records are in scope yet."}
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

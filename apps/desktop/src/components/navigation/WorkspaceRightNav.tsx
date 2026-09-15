import { useEffect, useId, useReducer, useRef, type ReactNode } from "react";
import type {
  CollaborationWorkItem,
  ConversationRoom,
  FableAgentProfile,
  LocalProject,
} from "@fable/protocol";
import { Folder } from "@phosphor-icons/react/dist/csr/Folder";
import { ChatCircle } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { Globe } from "@phosphor-icons/react/dist/csr/Globe";
import { X } from "@phosphor-icons/react/dist/csr/X";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { parseComputerArtifact } from "../../lib/computer-artifacts";
import { sideChatsFor, scopeWork } from "./work-order";
import { reduceRightPanel, type RightPanelTab } from "./right-panel-state";
import "./navigation.css";
import "./right-panel.css";

export type NavContext =
  | { kind: "agent"; agent: FableAgentProfile }
  | { kind: "project"; project: LocalProject }
  | { kind: "work"; item: CollaborationWorkItem }
  | null;

/** Content remains in the workspace that owns it; hiding the panel never stops work. */
export function WorkspaceRightNav({
  context,
  rooms,
  work,
  runtime,
  open,
  onClose,
  onOpenConversation,
  onNewSideChat,
  sideChats,
  schedules,
  onSchedules,
  request,
  renderTab,
  computer,
  computerAgentId,
  onCloseComputer,
  onChatActiveChange,
}: {
  context: NavContext;
  rooms: ConversationRoom[];
  work: CollaborationWorkItem[];
  runtime: ShellRuntime;
  open: boolean;
  onClose: () => void;
  onOpenConversation: (id: string, newTab?: boolean) => void;
  onNewSideChat?: () => void;
  sideChats?: ReactNode;
  schedules?: ReactNode;
  onSchedules?: () => void;
  request?: RightPanelTab | null;
  renderTab?: (tab: RightPanelTab, close: () => void) => ReactNode;
  computer?: ReactNode;
  computerAgentId?: string | null;
  onCloseComputer?: () => void;
  onChatActiveChange?: (active: boolean) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const compact = useMediaQuery("(max-width: 850px)");
  useModalFocusTrap({ active: open && compact, containerRef: panel, onClose });
  const prefix = useId();
  const [state, dispatch] = useReducer(reduceRightPanel, {
    tabs: [],
    selected: "files",
  });
  useEffect(() => {
    if (request) dispatch({ type: "open", tab: request });
  }, [request]);
  const lastSelection = useRef(state.selected);
  useEffect(() => {
    if (lastSelection.current === state.selected) return;
    lastSelection.current = state.selected;
    if (open)
      (
        panel.current?.querySelector(
          '[role="tab"][aria-selected="true"], nav [aria-pressed="true"]',
        ) as HTMLElement | null
      )?.focus();
  }, [state.selected, open]);
  const agentId =
    context?.kind === "agent"
      ? context.agent.id
      : context?.kind === "work"
        ? context.item.agentId
        : undefined;
  const project = context?.kind === "project" ? context.project : undefined;
  const chats = sideChatsFor(
    agentId
      ? { kind: "agent", agentId }
      : project
        ? { kind: "project", project }
        : null,
    rooms,
  );
  const files = (
    context ? scopeWork(work, { agentId, projectId: project?.id }) : []
  )
    .flatMap((item) =>
      item.outputs.flatMap((output) => {
        const artifact = parseComputerArtifact(output.text);
        return artifact
          ? [
              {
                id: `artifact:${item.agentId}:${artifact.id}`,
                kind: "artifact" as const,
                title: artifact.title,
                output: output.text,
                agentId: item.agentId,
              },
            ]
          : [];
      }),
    )
    .filter(
      (file, index, all) =>
        all.findIndex((other) => other.id === file.id) === index,
    );
  const selected = state.tabs.find((tab) => tab.id === state.selected);
  useEffect(() => {
    onChatActiveChange?.(!computerAgentId && selected?.kind === "chat");
  }, [selected?.id, computerAgentId, onChatActiveChange]);
  const select = (id: string) => {
    onCloseComputer?.();
    dispatch({ type: "select", id });
  };
  const closeTab = (id: string) => dispatch({ type: "close", id });
  const utilities = [
    { id: "files", label: "Files", Icon: Folder },
    { id: "chats", label: "Side chats", Icon: ChatCircle },
    { id: "schedules", label: "Schedules", Icon: Clock },
  ];
  return (
    <aside
      ref={panel}
      className="workspace-context right-panel"
      aria-label="Workspace panel"
      role={compact ? "dialog" : undefined}
      aria-modal={(compact && open) || undefined}
      hidden={!open}
    >
      <header className="right-panel__navigation">
        <nav aria-label="Panel views">
          {utilities.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              aria-pressed={!computerAgentId && state.selected === id}
              onClick={() => {
                select(id);
                if (id === "schedules" && !schedules) onSchedules?.();
              }}
            >
              <Icon size={17} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <button
          type="button"
          className="right-panel__close"
          aria-label="Close workspace panel"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      {state.tabs.length ? (
        <div
          className="right-panel__tabs"
          role="tablist"
          aria-label="Open content"
        >
          {state.tabs.map((tab, index) => {
            const Icon =
              tab.kind === "artifact" || tab.kind === "file"
                ? FileText
                : tab.kind === "web"
                  ? Globe
                  : ChatCircle;
            return (
              <div
                className="right-panel__tab"
                key={tab.id}
                data-active={!computerAgentId && state.selected === tab.id}
              >
                <button
                  type="button"
                  role="tab"
                  id={`${prefix}-tab-${index}`}
                  aria-controls={`${prefix}-content`}
                  aria-selected={!computerAgentId && state.selected === tab.id}
                  tabIndex={
                    state.selected === tab.id || (!selected && index === 0)
                      ? 0
                      : -1
                  }
                  onClick={() => select(tab.id)}
                  onKeyDown={(event) => {
                    let next: number | undefined;
                    if (event.key === "ArrowRight")
                      next = (index + 1) % state.tabs.length;
                    if (event.key === "ArrowLeft")
                      next =
                        (index + state.tabs.length - 1) % state.tabs.length;
                    if (event.key === "Home") next = 0;
                    if (event.key === "End") next = state.tabs.length - 1;
                    if (next !== undefined) {
                      event.preventDefault();
                      select(state.tabs[next].id);
                      document.getElementById(`${prefix}-tab-${next}`)?.focus();
                    }
                    if (event.key === "Delete") {
                      event.preventDefault();
                      closeTab(tab.id);
                      requestAnimationFrame(() =>
                        (
                          panel.current?.querySelector(
                            '[role="tab"][tabindex="0"]',
                          ) as HTMLElement | null
                        )?.focus(),
                      );
                    }
                  }}
                >
                  <Icon size={15} />
                  <span>{tab.title}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  onClick={() => closeTab(tab.id)}
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      <div
        id={`${prefix}-content`}
        className="right-panel__content"
        role={selected && !computerAgentId ? "tabpanel" : undefined}
        aria-labelledby={
          selected && !computerAgentId
            ? `${prefix}-tab-${state.tabs.indexOf(selected)}`
            : undefined
        }
      >
        {computerAgentId ? (
          computer
        ) : selected ? (
          renderTab?.(selected, () => closeTab(selected.id))
        ) : state.selected === "chats" ? (
          <div className="right-panel__library">
            {sideChats ?? (
              <>
                <div className="right-panel__section-heading">
                  <h2>Side chats</h2>
                  {onNewSideChat ? (
                    <button type="button" onClick={onNewSideChat}>
                      New chat
                    </button>
                  ) : null}
                </div>
                {chats.map((chat) => (
                  <button
                    className="right-panel__file"
                    key={chat.id}
                    onClick={() => onOpenConversation(chat.id)}
                  >
                    <ChatCircle size={18} />
                    <span>{chat.title}</span>
                  </button>
                ))}
                {!chats.length ? (
                  <p className="right-panel__empty">
                    A separate conversation, without losing your place.
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : state.selected === "schedules" ? (
          <div className="right-panel__library">
            {schedules ?? (
              <p className="right-panel__empty">
                Scheduled work for this conversation.
              </p>
            )}
          </div>
        ) : (
          <div className="right-panel__library">
            <div className="right-panel__section-heading">
              <h2>Files</h2>
              <small>
                {project?.name ??
                  runtime.agents.find((agent) => agent.id === agentId)?.name}
              </small>
            </div>
            {files.map((file) => (
              <button
                type="button"
                className="right-panel__file"
                key={file.id}
                onClick={() => dispatch({ type: "open", tab: file })}
              >
                <FileText size={19} />
                <span>{file.title}</span>
              </button>
            ))}
            {!files.length ? (
              <div className="right-panel__empty">
                <Folder size={28} />
                <p>Files your agent creates will appear here.</p>
                <small>
                  Open a file in the conversation to preview it alongside your
                  chat.
                </small>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  );
}

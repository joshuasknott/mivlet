import { useEffect, useId, useReducer, useRef, useState, type ReactNode } from "react";
import type {
  CollaborationWorkItem,
  ConversationRoom,
  MivletAgentProfile,
  LocalProject,
} from "@mivlet/protocol";
import { ChatCircle } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { CalendarBlank } from "@phosphor-icons/react/dist/csr/CalendarBlank";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { Globe } from "@phosphor-icons/react/dist/csr/Globe";
import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { X } from "@phosphor-icons/react/dist/csr/X";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { safeConversationLink } from "../../lib/safe-output";
import { sideChatsFor } from "./work-order";
import { reduceRightPanel, type RightPanelTab } from "./right-panel-state";
import "./navigation.css";
import "./right-panel.css";

export type NavContext =
  | { kind: "agent"; agent: MivletAgentProfile }
  | { kind: "project"; project: LocalProject }
  | { kind: "work"; item: CollaborationWorkItem }
  | null;

/** Content remains in the workspace that owns it; hiding the panel never stops work. */
export function WorkspaceRightNav({
  context,
  rooms,
  open,
  onClose,
  onOpenConversation,
  onNewSideChat,
  sideChats,
  schedules,
  library,
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
  onOpenConversation: (id: string) => void;
  onNewSideChat?: () => void;
  sideChats?: ReactNode;
  schedules?: ReactNode;
  library?: ReactNode;
  onSchedules?: () => void;
  request?: RightPanelTab | null;
  renderTab?: (tab: RightPanelTab, close: () => void) => ReactNode;
  computer?: ReactNode;
  computerAgentId?: string | null;
  onCloseComputer?: () => void;
  onChatActiveChange?: (active: boolean) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState("");
  const compact = useMediaQuery("(max-width: 850px)");
  useModalFocusTrap({ active: open && compact, containerRef: panel, onClose });
  const prefix = useId();
  const [state, dispatch] = useReducer(reduceRightPanel, {
    tabs: [],
    selected: "navigation",
  });
  useEffect(() => {
    if (request) dispatch({ type: "open", tab: request });
  }, [request]);
  const lastUtility = useRef("library");
  const navigationOnly = !computerAgentId && state.selected === "navigation";
  const lastSelection = useRef(state.selected);
  useEffect(() => {
    if (lastSelection.current === state.selected) return;
    lastSelection.current = state.selected;
    if (open)
      (
        (panel.current?.querySelector('[role="tab"][aria-selected="true"]') ??
          panel.current?.querySelector(navigationOnly ? `[data-utility="${lastUtility.current}"]` : '.right-panel__back')) as HTMLElement | null
      )?.focus();
  }, [state.selected, open, navigationOnly]);
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
  const selected = state.tabs.find((tab) => tab.id === state.selected);
  useEffect(() => {
    onChatActiveChange?.(open && !computerAgentId && selected?.kind === "chat");
  }, [selected?.id, open, computerAgentId, onChatActiveChange]);
  const select = (id: string) => {
    onCloseComputer?.();
    dispatch({ type: "select", id });
  };
  const closeTab = (id: string) => dispatch({ type: "close", id });
  const utilities = [
    { id: "library", label: "Library", Icon: FileText },
    { id: "browser", label: "Browser", Icon: Globe },
    { id: "chats", label: "Side chat", Icon: ChatCircle },
    { id: "schedules", label: "Schedules", Icon: CalendarBlank },
  ];
  return (
    <aside
      ref={panel}
      className="workspace-context right-panel"
      data-navigation-only={navigationOnly}
      aria-label="Workspace panel"
      role={compact ? "dialog" : undefined}
      aria-modal={(compact && open) || undefined}
      hidden={!open}
    >
      <header className={navigationOnly ? "right-panel__navigation" : "right-panel__destination"}>
        {navigationOnly ? <nav aria-label="Panel views">
          {utilities.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              data-utility={id}
              onClick={() => {
                lastUtility.current = id;
                select(id);
                if (id === "schedules" && !schedules) onSchedules?.();
              }}
            >
              <Icon size={17} />
              <span>{label}</span>
              <CaretRight size={14} aria-hidden="true" />
            </button>
          ))}
        </nav> : <button type="button" className="right-panel__back" onClick={() => select("navigation")}><ArrowLeft size={18} aria-hidden="true" />Back</button>}
        <button
          type="button"
          className="right-panel__close"
          aria-label="Close workspace panel"
          onClick={onClose}
        >
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="1" /><path d="M9 4.5v15" /></svg>
        </button>
      </header>
      {state.tabs.length && selected && !computerAgentId ? (
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
        hidden={!computerAgentId && state.selected === "navigation"}
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
        ) : state.selected === "library" ? (
          library ?? <p className="right-panel__empty">Saved files will appear here.</p>
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
        ) : state.selected === "browser" ? (
          <form className="right-panel__browser" onSubmit={(event) => {
            event.preventDefault();
            const value = address.trim();
            const url = safeConversationLink(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
            if (!url || !/^https?:/.test(url)) {
              setAddressError("Enter a valid website address.");
              return;
            }
            setAddressError("");
            dispatch({ type: "open", tab: { id: `web:${url}`, kind: "web", title: new URL(url).hostname, url } });
          }}>
            <label htmlFor={`${prefix}-address`}>Website address</label>
            <div>
              <input id={`${prefix}-address`} type="text" inputMode="url" autoComplete="url" placeholder="https://example.com" value={address} onChange={(event) => setAddress(event.target.value)} required />
              <button type="submit">Open</button>
            </div>
            {addressError ? <p role="alert">{addressError}</p> : null}
          </form>
        ) : null}
      </div>
    </aside>
  );
}

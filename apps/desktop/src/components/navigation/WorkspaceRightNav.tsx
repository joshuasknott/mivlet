import {
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  CollaborationWorkItem,
  LocalProject,
  MivletAgentProfile,
} from "@mivlet/protocol";
import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { ChatsCircle } from "@phosphor-icons/react/dist/csr/ChatsCircle";
import { CalendarBlank } from "@phosphor-icons/react/dist/csr/CalendarBlank";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { BookOpen } from "@phosphor-icons/react/dist/csr/BookOpen";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import {
  reduceRightPanel,
  type PanelPage,
  type RightPanelTab,
} from "./right-panel-state";
import "./navigation.css";
import "./right-panel.css";
import "./right-panel-rail.css";

export type NavContext =
  | { kind: "agent"; agent: MivletAgentProfile }
  | { kind: "project"; project: LocalProject }
  | { kind: "work"; item: CollaborationWorkItem }
  | null;

const sections = [
  { id: "activity", label: "Activity", icon: Clock },
  { id: "files", label: "Files", icon: FileText },
  { id: "memory", label: "Memory", icon: BookOpen },
  { id: "chats", label: "Side Chat", icon: ChatsCircle },
  { id: "schedules", label: "Schedules", icon: CalendarBlank },
] as const;

/** One content inspector; closing it returns to the preserved collection. */
export function WorkspaceRightNav({
  context,
  title,
  identity = "workspace",
  open: requestedOpen,
  replaced = false,
  onOpen,
  onClose,
  activity,
  library,
  memories,
  history,
  historyRequestId,
  sideChats,
  schedules,
  request,
  renderTab,
  computer,
  computerAgentId,
  onCloseComputer,
  onChatActiveChange,
}: {
  context: NavContext;
  title?: string;
  identity?: string;
  open: boolean;
  replaced?: boolean;
  onOpen?: () => void;
  onClose: () => void;
  activity?: (navigate: (page: PanelPage) => void) => ReactNode;
  library?: ReactNode;
  memories?: ReactNode;
  history?: ReactNode;
  historyRequestId?: string | null;
  sideChats?: ReactNode;
  schedules?: ReactNode;
  request?: RightPanelTab | null;
  renderTab?: (tab: RightPanelTab, close: () => void) => ReactNode;
  computer?: ReactNode;
  computerAgentId?: string | null;
  onCloseComputer?: () => void;
  onChatActiveChange?: (active: boolean) => void;
}) {
  const open = requestedOpen && !replaced;
  const panel = useRef<HTMLElement>(null);
  const compact = useMediaQuery("(max-width: 850px)");
  useModalFocusTrap({
    active: open && compact,
    containerRef: panel,
    onClose,
  });
  const prefix = useId();
  const [state, dispatch] = useReducer(reduceRightPanel, {
    page: "activity",
    content: null,
  });
  const [visited, setVisited] = useState<ReadonlySet<PanelPage>>(
    () => new Set(["activity"]),
  );
  const scopeKey = identity;
  const previous = useRef({
    identity,
    scopeKey,
    request: null as RightPanelTab | null | undefined,
  });
  useEffect(() => {
    if (previous.current.identity !== identity) {
      dispatch({ type: "reset" });
      setVisited(new Set(["activity"]));
    } else if (previous.current.scopeKey !== scopeKey)
      dispatch({ type: "close" });
    // An old request must not reopen a previous chat's inspector after navigation.
    if (request && request !== previous.current.request)
      dispatch({ type: "open", tab: request, scopeKey });
    previous.current = { identity, scopeKey, request };
  }, [identity, scopeKey, request]);
  const navigate = (page: PanelPage) => {
    onCloseComputer?.();
    setVisited((current) => new Set([...current, page]));
    dispatch({ type: "select", page });
    onOpen?.();
  };
  const lastHistory = useRef<string | null>(null);
  useEffect(() => {
    if (historyRequestId && historyRequestId !== lastHistory.current) {
      setVisited((current) => new Set([...current, "history"]));
      dispatch({ type: "select", page: "history" });
    }
    lastHistory.current = historyRequestId ?? null;
  }, [historyRequestId]);
  const selected =
    state.content?.scopeKey === scopeKey ? state.content.tab : undefined;
  const inspecting = Boolean(selected || computerAgentId);
  const activeSection = ["history"].includes(state.page)
    ? "activity"
    : state.page;
  const closePanel = () => {
    onClose();
    document.getElementById(prefix + "-" + activeSection)?.focus();
  };
  const closeContent = () => {
    onCloseComputer?.();
    dispatch({ type: "close" });
  };
  useEffect(() => {
    const closeApp = (event: Event) => {
      if (
        selected?.kind === "mcp-app" &&
        (event as CustomEvent<{ id?: string }>).detail?.id === selected.id
      )
        dispatch({ type: "close" });
    };
    window.addEventListener("mivlet:mcp-app-panel-closed", closeApp);
    return () =>
      window.removeEventListener("mivlet:mcp-app-panel-closed", closeApp);
  }, [selected?.id, selected?.kind]);
  useEffect(() => {
    if (selected?.kind !== "mcp-app" || !open || computerAgentId) return;
    const target = Array.from(
      panel.current?.querySelectorAll<HTMLElement>("[data-mcp-app-panel]") ??
        [],
    ).find((candidate) => candidate.dataset.mcpAppPanel === selected.id);
    if (target)
      window.dispatchEvent(
        new CustomEvent("mivlet:mcp-app-panel-ready", {
          detail: { id: selected.id, target },
        }),
      );
  }, [selected?.id, selected?.kind, open, computerAgentId]);
  const dockedApp = useRef<string | undefined>(undefined);
  useEffect(() => {
    const next =
      selected?.kind === "mcp-app" && !computerAgentId
        ? selected.id
        : undefined;
    const previousApp = dockedApp.current;
    dockedApp.current = next;
    if (previousApp && previousApp !== next)
      window.dispatchEvent(
        new CustomEvent("mivlet:mcp-app-panel-closed", {
          detail: { id: previousApp },
        }),
      );
  }, [selected?.id, selected?.kind, computerAgentId]);
  useEffect(
    () => () => {
      if (dockedApp.current)
        window.dispatchEvent(
          new CustomEvent("mivlet:mcp-app-panel-closed", {
            detail: { id: dockedApp.current },
          }),
        );
    },
    [],
  );
  const focusKey = inspecting ? (selected?.id ?? "computer") : state.page;
  const lastFocus = useRef(focusKey);
  useEffect(() => {
    if (lastFocus.current === focusKey) return;
    lastFocus.current = focusKey;
    if (open)
      panel.current
        ?.querySelector<HTMLElement>(
          inspecting
            ? ".right-panel__back"
            : '[role="tab"][aria-selected="true"]',
        )
        ?.focus();
  }, [focusKey, inspecting, open]);
  useEffect(() => {
    onChatActiveChange?.(open && !computerAgentId && selected?.kind === "chat");
  }, [open, computerAgentId, selected?.id, selected?.kind, onChatActiveChange]);
  const contextName =
    context?.kind === "project"
      ? context.project.name
      : context?.kind === "agent"
        ? context.agent.name
        : undefined;
  const heading = {
    activity: "Activity",
    files: "Files",
    memory: "Memory",
    history: "Work history",
    chats: "Side Chat",
    schedules: "Schedules",
  }[state.page];
  const pages: { id: PanelPage; content: ReactNode }[] = [
    {
      id: "activity",
      content: activity?.(navigate) ?? (
        <p className="right-panel__empty">
          Choose a conversation to see its activity.
        </p>
      ),
    },
    {
      id: "files",
      content: library ?? (
        <p className="right-panel__empty">
          Files shared or created here will appear here.
        </p>
      ),
    },
    {
      id: "memory",
      content: memories ?? (
        <p className="right-panel__empty">
          Choose a conversation to manage its memory.
        </p>
      ),
    },
    {
      id: "history",
      content: (
        <div className="right-panel__library">
          <button
            type="button"
            className="workspace-panel__link"
            onClick={() => navigate("activity")}
          >
            <ArrowLeft size={15} aria-hidden="true" />
            Back to Activity
          </button>
          {history}
        </div>
      ),
    },
    {
      id: "chats",
      content: <div className="right-panel__library">{sideChats ?? <p className="right-panel__empty">Choose an agent or project to start a side chat.</p>}</div>,
    },
    {
      id: "schedules",
      content: <div className="right-panel__library">{schedules}</div>,
    },
  ];
  return (
    <aside
      ref={panel}
      className="workspace-context right-panel"
      data-open={open}
      aria-label="Workspace panel"
      aria-description={title || contextName}
      role={compact && open ? "dialog" : undefined}
      aria-modal={(compact && open) || undefined}
      data-replaced={replaced}
    >
      <div className="right-panel__body" hidden={!open}>
        <header className="right-panel__header">
          {inspecting ? (
            <div className="right-panel__inspector-title">
              <button
                type="button"
                className="right-panel__back"
                onClick={closeContent}
              >
                <ArrowLeft size={17} aria-hidden="true" />
                Back
              </button>
              <h2 title={selected?.title}>
                {computerAgentId ? "Computer" : selected?.title}
              </h2>
            </div>
          ) : (
            <div className="right-panel__heading">
              <h2>{heading}</h2>
            </div>
          )}
          <div className="right-panel__controls">
            <button
              type="button"
              aria-label="Close workspace panel"
              onClick={closePanel}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className="right-panel__content" id={prefix + "-content"}>
          {pages.map(({ id, content }) => (
            <div
              key={id + ":" + scopeKey}
              className="right-panel__page"
              id={prefix + "-page-" + id}
              role="tabpanel"
              aria-labelledby={
                prefix +
                "-" +
                (sections.some((section) => section.id === id)
                  ? id
                  : "activity")
              }
              hidden={inspecting || state.page !== id}
            >
              {visited.has(id) ? content : null}
            </div>
          ))}
          <div
            className="right-panel__inspector"
            id={prefix + "-inspector"}
            hidden={!inspecting}
          >
            {computerAgentId
              ? computer
              : selected
                ? renderTab?.(selected, closeContent)
                : null}
          </div>
        </div>
      </div>
      <nav className="right-panel__rail" aria-label="Workspace tools">
        <div
          className="right-panel__sections"
          role="tablist"
          aria-label="Workspace sections"
          aria-orientation="vertical"
        >
          {sections.map((section, index) => (
            <button
              key={section.id}
              type="button"
              role="tab"
              id={prefix + "-" + section.id}
              aria-selected={open && activeSection === section.id}
              aria-expanded={open && activeSection === section.id}
              aria-controls={
                inspecting && activeSection === section.id
                  ? prefix + "-inspector"
                  : prefix +
                    "-page-" +
                    (activeSection === section.id ? state.page : section.id)
              }
              tabIndex={activeSection === section.id ? 0 : -1}
              onClick={() => navigate(section.id)}
              onKeyDown={(event) => {
                const next = ["ArrowDown", "ArrowRight"].includes(event.key)
                  ? (index + 1) % sections.length
                  : ["ArrowUp", "ArrowLeft"].includes(event.key)
                    ? (index + sections.length - 1) % sections.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? sections.length - 1
                        : undefined;
                if (next === undefined) return;
                event.preventDefault();
                navigate(sections[next].id);
                document
                  .getElementById(prefix + "-" + sections[next].id)
                  ?.focus();
              }}
            >
              <span className="right-panel__rail-icon">
                <section.icon size={22} aria-hidden="true" />
              </span>
              <span>{section.label}</span>
            </button>
          ))}
        </div>
      </nav>
    </aside>
  );
}

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
import { ArrowsOutSimple } from "@phosphor-icons/react/dist/csr/ArrowsOutSimple";
import { ArrowsInSimple } from "@phosphor-icons/react/dist/csr/ArrowsInSimple";
import { DotsThree } from "@phosphor-icons/react/dist/csr/DotsThree";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import {
  reduceRightPanel,
  type PanelPage,
  type RightPanelTab,
} from "./right-panel-state";
import type { PanelScope } from "./workspace-panel-data";
import "./navigation.css";
import "./right-panel.css";

export type NavContext =
  | { kind: "agent"; agent: MivletAgentProfile }
  | { kind: "project"; project: LocalProject }
  | { kind: "work"; item: CollaborationWorkItem }
  | null;

const sections = [
  { id: "activity", label: "Activity" },
  { id: "files", label: "Files" },
  { id: "memory", label: "Memory" },
] as const;

/** One content inspector; closing it returns to the preserved collection. */
export function WorkspaceRightNav({
  context,
  title,
  identity = "workspace",
  scope = "chat",
  ownerLabel,
  onScopeChange,
  open,
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
  scope?: PanelScope;
  ownerLabel?: string;
  onScopeChange?: (scope: PanelScope) => void;
  open: boolean;
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
  const panel = useRef<HTMLElement>(null);
  const more = useRef<HTMLDetailsElement>(null);
  const compact = useMediaQuery("(max-width: 850px)");
  useModalFocusTrap({ active: open && compact, containerRef: panel, onClose });
  const prefix = useId();
  const [state, dispatch] = useReducer(reduceRightPanel, {
    page: "activity",
    content: null,
  });
  const [expanded, setExpanded] = useState(false);
  const [visited, setVisited] = useState<ReadonlySet<PanelPage>>(
    () => new Set(["activity"]),
  );
  const scopeKey = identity + ":" + scope;
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
    if (more.current) more.current.open = false;
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
  const activeSection = ["history", "chats", "schedules"].includes(state.page)
    ? "activity"
    : state.page;
  const closeContent = () => {
    onCloseComputer?.();
    dispatch({ type: "close" });
    if (selected?.kind === "mcp-app") window.dispatchEvent(new CustomEvent("mivlet:mcp-app-panel-closed", { detail: { id: selected.id } }));
  };
  useEffect(() => {
    const closeApp = (event: Event) => {
      if (selected?.kind === "mcp-app" && (event as CustomEvent<{ id?: string }>).detail?.id === selected.id)
        dispatch({ type: "close" });
    };
    window.addEventListener("mivlet:mcp-app-panel-closed", closeApp);
    return () => window.removeEventListener("mivlet:mcp-app-panel-closed", closeApp);
  }, [selected?.id, selected?.kind]);
  useEffect(() => {
    if (selected?.kind !== "mcp-app" || !open || computerAgentId) return;
    const target = Array.from(panel.current?.querySelectorAll<HTMLElement>("[data-mcp-app-panel]") ?? [])
      .find((candidate) => candidate.dataset.mcpAppPanel === selected.id);
    if (target) window.dispatchEvent(new CustomEvent("mivlet:mcp-app-panel-ready", { detail: { id: selected.id, target } }));
  }, [selected?.id, selected?.kind, open, computerAgentId]);
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
  const heading = title || contextName || "Workspace";
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
      content: <div className="right-panel__library">{sideChats}</div>,
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
      data-expanded={expanded}
      aria-label="Workspace panel"
      role={compact ? "dialog" : undefined}
      aria-modal={(compact && open) || undefined}
      hidden={!open}
    >
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
            <h2 title={heading}>{heading}</h2>
            {onScopeChange && ownerLabel ? (
              <select
                aria-label="Panel scope"
                value={scope}
                onChange={(event) =>
                  onScopeChange(event.target.value as PanelScope)
                }
              >
                <option value="chat">This chat</option>
                <option value="owner">All in {ownerLabel}</option>
              </select>
            ) : null}
          </div>
        )}
        <div className="right-panel__controls">
          {!inspecting && (sideChats || schedules) ? (
            <details
              ref={more}
              className="right-panel__more"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.currentTarget.open = false;
                  event.currentTarget.querySelector("summary")?.focus();
                  event.stopPropagation();
                }
              }}
            >
              <summary aria-label="More workspace options">
                <DotsThree size={20} aria-hidden="true" />
              </summary>
              <div>
                {sideChats ? (
                  <button type="button" onClick={() => navigate("chats")}>
                    Conversations
                  </button>
                ) : null}
                {schedules ? (
                  <button type="button" onClick={() => navigate("schedules")}>
                    Schedules
                  </button>
                ) : null}
              </div>
            </details>
          ) : null}
          <button
            type="button"
            className="right-panel__expand"
            aria-label={
              expanded ? "Reduce workspace panel" : "Expand workspace panel"
            }
            aria-pressed={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? (
              <ArrowsInSimple size={18} aria-hidden="true" />
            ) : (
              <ArrowsOutSimple size={18} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="right-panel__close"
            aria-label="Close workspace panel"
            onClick={onClose}
          >
            <X size={19} aria-hidden="true" />
          </button>
        </div>
      </header>
      {!inspecting && (
        <div
          className="right-panel__sections"
          role="tablist"
          aria-label="Workspace sections"
        >
          {sections.map((section, index) => (
            <button
              key={section.id}
              type="button"
              role="tab"
              id={prefix + "-" + section.id}
              aria-selected={activeSection === section.id}
              aria-controls={
                prefix +
                "-page-" +
                (activeSection === section.id ? state.page : section.id)
              }
              tabIndex={activeSection === section.id ? 0 : -1}
              onClick={() => navigate(section.id)}
              onKeyDown={(event) => {
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % sections.length
                    : event.key === "ArrowLeft"
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
              {section.label}
            </button>
          ))}
        </div>
      )}
      <div className="right-panel__content">
        {pages.map(({ id, content }) => (
          <div
            key={id + ":" + scopeKey}
            className="right-panel__page"
            id={prefix + "-page-" + id}
            role="tabpanel"
            aria-labelledby={
              sections.some((section) => section.id === id)
                ? prefix + "-" + id
                : prefix + "-activity"
            }
            hidden={inspecting || state.page !== id}
          >
            {visited.has(id) ? content : null}
          </div>
        ))}
        {computerAgentId
          ? computer
          : selected
            ? renderTab?.(selected, closeContent)
            : null}
      </div>
    </aside>
  );
}

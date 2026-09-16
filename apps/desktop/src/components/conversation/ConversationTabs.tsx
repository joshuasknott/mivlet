import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { CaretDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import type {
  ConversationLayout,
  ConversationLayoutNode,
} from "@mivlet/protocol";
import { type LayoutAction } from "../../lib/conversation-layout";

/** A contextual New target: it names the object it will create. */
export interface NewAction {
  id: string;
  label: string;
  run: () => void;
}

export function ConversationTabs({
  layout,
  titles,
  indicators,
  descriptions = {},
  onAction,
  onCreate,
  newActions,
}: {
  layout: ConversationLayout;
  titles: Record<string, string>;
  indicators: Record<string, string>;
  descriptions?: Record<string, string>;
  onAction: (action: LayoutAction) => void;
  onCreate?: () => void;
  /** Contextual New creates relevant objects, never generic conversations. */
  newActions?: NewAction[];
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHost(document.getElementById("window-tabs"));
  }, []);
  const ids = layout.panes.flat(),
    active = layout.active[layout.activePane];
  const strip = useRef<HTMLDivElement>(null);
  const overflowTrigger = useRef<HTMLButtonElement>(null);
  const overflowPanel = useRef<HTMLDivElement>(null);
  const newTrigger = useRef<HTMLButtonElement>(null);
  const newMenu = useRef<HTMLDivElement>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (newMenuOpen)
      newMenu.current
        ?.querySelector<HTMLButtonElement>("[role='menuitem']")
        ?.focus();
  }, [newMenuOpen]);
  useEffect(() => {
    const reveal = () => { if (active) document
        .getElementById(`tab-${active}`)
        ?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); };
    reveal();
    window.addEventListener("resize", reveal);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reveal);
    if (strip.current) observer?.observe(strip.current);
    return () => { window.removeEventListener("resize", reveal); observer?.disconnect(); };
  }, [active, host]);
  useEffect(() => {
    if (!newMenuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!newMenu.current?.contains(event.target as Node)) setNewMenuOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [newMenuOpen]);
  useEffect(() => {
    if (!overflowOpen) return;
    overflowPanel.current?.querySelector("input")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!overflowPanel.current?.contains(event.target as Node) && !overflowTrigger.current?.contains(event.target as Node)) setOverflowOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [overflowOpen]);
  const entries = ids.map(id => {
    const view = layout.views.find(view => view.id === id)!;
    return { id, view, title: view.kind === "artifact" ? view.title : titles[view.conversationId] ?? "Conversation" };
  });
  const focus = (id?: string) =>
    requestAnimationFrame(() =>
      id
        ? document.getElementById(`tab-${id}`)?.focus()
        : strip.current
            ?.querySelector<HTMLButtonElement>(".conversation-tabs__new")
            ?.focus(),
    );
  const close = (id: string) => {
    const i = ids.indexOf(id);
    onAction({ type: "close", id });
    focus(ids[i + 1] ?? ids[i - 1]);
  };
  const tabs = (
    <div className="conversation-tabs" ref={strip} data-conversation-tabs>
      <div
        role="tablist"
        aria-label="Open conversations and files"
        className="conversation-tabs__list"
      >
        {ids.map((id) => {
          const view = layout.views.find((view) => view.id === id)!;
          const title =
            view.kind === "artifact"
              ? view.title
              : (titles[view.conversationId] ?? "Conversation");
          const indicator = indicators[view.conversationId];
          return (
            <div
              key={id}
              className={`conversation-tab${id === active ? " conversation-tab--active" : ""}`}
              role="presentation"
              data-conversation-view={id}
              data-conversation-tab={id}
              onDragStart={(event) => event.preventDefault()}
            >
              <button
                type="button"
                role="tab"
                id={`tab-${id}`}
                aria-controls={`panel-${id}`}
                aria-selected={id === active}
                tabIndex={id === active ? 0 : -1}
                title={`${title}${indicator ? ` · ${indicator}` : ""}`}
                onClick={() => onAction({ type: "activate", id })}
                onKeyDown={(event) => {
                  const index = ids.indexOf(id),
                    pane = layout.panes.findIndex((ids) => ids.includes(id));
                  if (
                    event.ctrlKey &&
                    event.altKey &&
                    [
                      "ArrowLeft",
                      "ArrowRight",
                      "ArrowUp",
                      "ArrowDown",
                    ].includes(event.key)
                  ) {
                    event.preventDefault();
                    onAction({
                      type: "dock",
                      id,
                      pane: layout.activePane,
                      edge: (
                        {
                          ArrowLeft: "left",
                          ArrowRight: "right",
                          ArrowUp: "top",
                          ArrowDown: "bottom",
                        } as const
                      )[event.key as "ArrowLeft"],
                    });
                    return;
                  }
                  if (
                    event.altKey &&
                    event.shiftKey &&
                    ["ArrowLeft", "ArrowRight"].includes(event.key)
                  ) {
                    event.preventDefault();
                    onAction({
                      type: "move",
                      id,
                      pane,
                      index:
                        layout.panes[pane].indexOf(id) +
                        (event.key === "ArrowRight" ? 1 : -1),
                    });
                    focus(id);
                    return;
                  }
                  if (event.key === "Delete") {
                    event.preventDefault();
                    close(id);
                    return;
                  }
                  if (
                    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  const target =
                    ids[
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? ids.length - 1
                          : (index +
                              (event.key === "ArrowRight" ? 1 : -1) +
                              ids.length) %
                            ids.length
                    ];
                  onAction({ type: "activate", id: target });
                  focus(target);
                }}
              >
                <span
                  className={`conversation-tab__indicator${indicator === "Working" ? " conversation-tab__indicator--working" : ""}`}
                  aria-label={indicator}
                >
                  {indicator
                    ? ["Working", "Unread"].includes(indicator)
                      ? "•"
                      : "!"
                    : view.kind === "artifact"
                      ? "▤"
                      : ""}
                </span>
                <span>{title.replace(/^Conversation with /, "")}{entries.filter(entry => entry.title === title).length > 1 ? ` · ${entries.filter(entry => entry.title === title).findIndex(entry => entry.id === id) + 1}` : ""}</span>
              </button>
              <button
                type="button"
                className="conversation-tab__close"
                data-conversation-no-drag
                tabIndex={id === active ? 0 : -1}
                aria-label={`Close ${title}`}
                onClick={() => close(id)}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      {newActions?.length ? (
        <div className="conversation-tabs__new-menu">
          <button
            ref={newTrigger}
            type="button"
            className="conversation-tabs__new"
            aria-label="New"
            title="New"
            aria-haspopup="menu"
            aria-expanded={newMenuOpen}
            onClick={() => {
              setNewMenuOpen((open) => !open);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && !newMenuOpen) {
                event.preventDefault();
                setNewMenuOpen(true);
              }
            }}
          >
            <Plus size={16} />
          </button>
          {newMenuOpen ? (
            <div
              ref={newMenu}
              className="conversation-tabs-menu conversation-tabs-menu--new"
              role="menu"
              aria-label="Create"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setNewMenuOpen(false);
                  newTrigger.current?.focus();
                }
                if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                  event.preventDefault();
                  const buttons = [
                    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      "[role='menuitem']",
                    ),
                  ];
                  const i = buttons.indexOf(
                    document.activeElement as HTMLButtonElement,
                  );
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? buttons.length - 1
                        : i < 0
                          ? (event.key === "ArrowDown" ? 0 : buttons.length - 1)
                          : (i + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                            buttons.length;
                  buttons[next]?.focus();
                }
              }}
            >
              {newActions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setNewMenuOpen(false);
                    newTrigger.current?.focus();
                    action.run();
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : onCreate ? (
        <button
          type="button"
          className="conversation-tabs__new"
          aria-label="New conversation"
          title="New conversation"
          onClick={onCreate}
        >
          <Plus size={16} />
        </button>
      ) : null}
      <button ref={overflowTrigger} type="button" className="conversation-tabs__overflow" aria-label="Search open tabs" aria-expanded={overflowOpen} aria-haspopup="dialog" onClick={() => { setQuery(""); setOverflowOpen(!overflowOpen); }}><CaretDown size={16} /></button>
      {overflowOpen ? createPortal(<div ref={overflowPanel} className="conversation-tabs-menu" role="dialog" aria-label="Open tabs" onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOverflowOpen(false); overflowTrigger.current?.focus(); }
        if (["ArrowDown", "ArrowUp"].includes(event.key)) {
          event.preventDefault(); const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")]; const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = i < 0 ? (event.key === "ArrowDown" ? 0 : buttons.length - 1) : (i + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      }}>
        <input type="search" aria-label="Search open tabs" placeholder="Search open tabs…" value={query} onChange={event => setQuery(event.target.value)} />
        <div>{entries.filter(entry => `${entry.title} ${descriptions[entry.view.conversationId] ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())).map(entry => <button type="button" key={entry.id} aria-current={entry.id === active ? "page" : undefined} onClick={() => { onAction({ type: "activate", id: entry.id }); setOverflowOpen(false); focus(entry.id); }}><strong>{entry.title}</strong><small>{descriptions[entry.view.conversationId]}{indicators[entry.view.conversationId] ? ` · ${indicators[entry.view.conversationId]}` : ""}</small></button>)}</div>
        {!entries.some(entry => `${entry.title} ${descriptions[entry.view.conversationId] ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())) ? <p>No matching open tabs.</p> : null}
      </div>, document.body) : null}
    </div>
  );
  return host ? createPortal(tabs, host) : tabs;
}

export function ConversationGrid({
  layout,
  compact,
  onAction,
  renderPane,
}: {
  layout: ConversationLayout;
  compact: boolean;
  onAction: (action: LayoutAction) => void;
  renderPane: (pane: number) => ReactNode;
}) {
  const render = (node: ConversationLayoutNode, path: number[]): ReactNode =>
    node.kind === "pane" ? (
      <div
        key={node.pane}
        className="conversation-dock"
        data-conversation-pane={node.pane}
      >
        {renderPane(node.pane)}
      </div>
    ) : (
      <div
        className={`conversation-grid-split conversation-grid-split--${node.axis}`}
        style={
          node.axis === "row"
            ? {
                gridTemplateColumns: `minmax(0, ${node.ratio}fr) 5px minmax(0, ${1 - node.ratio}fr)`,
              }
            : {
                gridTemplateRows: `minmax(0, ${node.ratio}fr) 5px minmax(0, ${1 - node.ratio}fr)`,
              }
        }
      >
        {render(node.children[0], [...path, 0])}
        <PaneDivider
          axis={node.axis}
          ratio={node.ratio}
          onResize={(ratio) => onAction({ type: "resize", path, ratio })}
        />
        {render(node.children[1], [...path, 1])}
      </div>
    );
  return (
    <div className="conversation-panes">
      {compact ? renderPane(layout.activePane) : render(layout.tree, [])}
    </div>
  );
}

export function PaneDivider({
  ratio,
  onResize,
  axis = "row",
}: {
  ratio: number;
  onResize: (ratio: number) => void;
  axis?: "row" | "column";
}) {
  return (
    <div
      className={`conversation-divider conversation-divider--${axis}`}
      role="separator"
      tabIndex={0}
      aria-label="Resize conversation panes"
      aria-orientation={axis === "row" ? "vertical" : "horizontal"}
      aria-valuemin={20}
      aria-valuemax={80}
      aria-valuenow={Math.round(ratio * 100)}
      onKeyDown={(event) => {
        const backward = axis === "row" ? "ArrowLeft" : "ArrowUp",
          forward = axis === "row" ? "ArrowRight" : "ArrowDown";
        if ([backward, forward, "Home", "End"].includes(event.key)) {
          event.preventDefault();
          onResize(
            event.key === "Home"
              ? 0.2
              : event.key === "End"
                ? 0.8
                : ratio + (event.key === forward ? 0.025 : -0.025),
          );
        }
      }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus();
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const bounds = event.currentTarget
          .closest(".conversation-grid-split")
          ?.getBoundingClientRect();
        if (bounds && (axis === "row" ? bounds.width : bounds.height) > 0)
          onResize(
            axis === "row"
              ? (event.clientX - bounds.left) / bounds.width
              : (event.clientY - bounds.top) / bounds.height,
          );
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    />
  );
}

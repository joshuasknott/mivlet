import { useRef } from "react";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { Columns } from "@phosphor-icons/react/dist/csr/Columns";
import type { ConversationLayout, WorkspaceView } from "@fable/protocol";
import type { LayoutAction } from "../../lib/conversation-layout";

export function ConversationTabs({
  layout,
  pane,
  compact,
  titles,
  indicators,
  onAction,
  onCreate,
}: {
  layout: ConversationLayout;
  pane: 0 | 1;
  compact: boolean;
  titles: Record<string, string>;
  indicators: Record<string, string>;
  onAction: (action: LayoutAction) => void;
  onCreate: () => void;
}) {
  const ids = compact
    ? [...layout.panes[0], ...layout.panes[1]]
    : layout.panes[pane];
  const active = layout.active[pane];
  const strip = useRef<HTMLDivElement>(null);
  const focus = (id: string | null) =>
    requestAnimationFrame(() => {
      if (id) document.getElementById(`tab-${id}`)?.focus();
      else
        strip.current
          ?.querySelector<HTMLButtonElement>(".conversation-tabs__new")
          ?.focus();
    });
  const apply = (action: LayoutAction, focusId?: string | null) => {
    onAction(action);
    if (focusId !== undefined) focus(focusId);
  };
  const close = (id: string) => {
    const i = ids.indexOf(id);
    apply({ type: "close", id }, ids[i + 1] ?? ids[i - 1] ?? null);
  };
  const split = () => {
    const view = layout.views.find((view) => view.id === active);
    const duplicate: WorkspaceView | undefined = view
      ? { ...view, id: `view-${crypto.randomUUID()}` }
      : undefined;
    apply({ type: "split", view: duplicate }, duplicate?.id);
  };
  return (
    <div className="conversation-tabs" ref={strip}>
      <div
        role="tablist"
        aria-label={
          compact
            ? "Open conversations and files"
            : `${pane === 0 ? "Left" : "Right"} pane tabs`
        }
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
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData("application/x-mivlet-view", id);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => {
                if (
                  event.dataTransfer.types.includes("application/x-mivlet-view")
                )
                  event.preventDefault();
              }}
              onDrop={(event) => {
                const source = event.dataTransfer.getData(
                  "application/x-mivlet-view",
                );
                if (source) {
                  event.preventDefault();
                  const targetPane = layout.panes[0].includes(id) ? 0 : 1;
                  apply(
                    {
                      type: "move",
                      id: source,
                      pane: targetPane,
                      index: layout.panes[targetPane].indexOf(id),
                    },
                    source,
                  );
                }
              }}
            >
              <button
                type="button"
                role="tab"
                id={`tab-${id}`}
                aria-controls={`panel-${id}`}
                aria-selected={id === active}
                tabIndex={id === active ? 0 : -1}
                title={`${title}${indicator ? ` · ${indicator}` : ""}`}
                onClick={() => apply({ type: "activate", id })}
                onKeyDown={(event) => {
                  const index = ids.indexOf(id);
                  if (
                    event.altKey &&
                    event.shiftKey &&
                    ["ArrowLeft", "ArrowRight"].includes(event.key)
                  ) {
                    event.preventDefault();
                    const owner = layout.panes[0].includes(id) ? 0 : 1;
                    apply(
                      {
                        type: "move",
                        id,
                        pane: owner,
                        index:
                          layout.panes[owner].indexOf(id) +
                          (event.key === "ArrowRight" ? 1 : -1),
                      },
                      id,
                    );
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
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? ids.length - 1
                        : (index +
                            (event.key === "ArrowRight" ? 1 : -1) +
                            ids.length) %
                          ids.length;
                  apply({ type: "activate", id: ids[next] }, ids[next]);
                }}
              >
                <span
                  className={`conversation-tab__indicator${indicator === "Working" ? " conversation-tab__indicator--working" : ""}`}
                  aria-label={indicator}
                  title={indicator}
                >
                  {indicator
                    ? indicator === "Working" || indicator === "Unread"
                      ? "•"
                      : "!"
                    : view.kind === "artifact"
                      ? "▤"
                      : ""}
                </span>
                <span>{title}</span>
              </button>
              <button
                type="button"
                className="conversation-tab__close"
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
      <button
        type="button"
        className="conversation-tabs__new"
        aria-label="New conversation"
        title="New conversation"
        onClick={onCreate}
      >
        <Plus size={16} />
      </button>
      <details className="conversation-tabs__menu">
        <summary
          aria-label="Tab and split options"
          title="Tab and split options"
        >
          <Columns size={17} />
        </summary>
        <div>
          <button
            type="button"
            onClick={(event) => {
              split();
              event.currentTarget.closest("details")?.removeAttribute("open");
            }}
          >
            Split this view
          </button>
          <button
            type="button"
            disabled={!active}
            onClick={(event) => {
              if (active)
                apply(
                  {
                    type: "move",
                    id: active,
                    pane: pane === 0 ? 1 : 0,
                    index: 999,
                  },
                  active,
                );
              event.currentTarget.closest("details")?.removeAttribute("open");
            }}
          >
            Move tab to other pane
          </button>
          <button
            type="button"
            disabled={!active}
            onClick={() => {
              if (active)
                apply(
                  {
                    type: "move",
                    id: active,
                    pane,
                    index: Math.max(0, layout.panes[pane].indexOf(active) - 1),
                  },
                  active,
                );
            }}
          >
            Move tab left
          </button>
          <button
            type="button"
            disabled={!active}
            onClick={() => {
              if (active)
                apply(
                  {
                    type: "move",
                    id: active,
                    pane,
                    index: layout.panes[pane].indexOf(active) + 1,
                  },
                  active,
                );
            }}
          >
            Move tab right
          </button>
          <button
            type="button"
            disabled={!layout.split}
            onClick={(event) => {
              apply({ type: "swap" }, active);
              event.currentTarget.closest("details")?.removeAttribute("open");
            }}
          >
            Swap panes
          </button>
          <button
            type="button"
            disabled={!layout.split}
            onClick={(event) => {
              apply({ type: "single" }, active);
              event.currentTarget.closest("details")?.removeAttribute("open");
            }}
          >
            Return to one pane
          </button>
          <button
            type="button"
            disabled={!layout.closed.length}
            onClick={(event) => {
              apply({ type: "reopen" }, layout.closed.at(-1)?.id);
              event.currentTarget.closest("details")?.removeAttribute("open");
            }}
          >
            Reopen closed tab <small>Ctrl Shift T</small>
          </button>
        </div>
      </details>
    </div>
  );
}

export function PaneDivider({
  ratio,
  onResize,
}: {
  ratio: number;
  onResize: (ratio: number) => void;
}) {
  return (
    <div
      className="conversation-divider"
      role="separator"
      tabIndex={0}
      aria-label="Resize conversation panes"
      aria-orientation="vertical"
      aria-valuemin={25}
      aria-valuemax={75}
      aria-valuenow={Math.round(ratio * 100)}
      onKeyDown={(event) => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          onResize(
            event.key === "Home"
              ? 0.25
              : event.key === "End"
                ? 0.75
                : ratio + (event.key === "ArrowRight" ? 0.025 : -0.025),
          );
        }
      }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus();
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        // The immediate wrapper uses display:contents and has no layout box.
        const bounds = event.currentTarget
          .closest(".conversation-panes")
          ?.getBoundingClientRect();
        if (bounds && bounds.width > 0)
          onResize((event.clientX - bounds.left) / bounds.width);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    />
  );
}

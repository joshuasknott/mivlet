import type { ConversationLayout, ConversationLayoutNode } from "@fable/protocol";
import type { ReactNode } from "react";
import type { LayoutAction } from "../../lib/conversation-layout";

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

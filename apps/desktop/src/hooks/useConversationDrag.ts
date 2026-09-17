import {
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ConversationLayout } from "@fable/protocol";
import { MAX_PANES, type DockEdge, type LayoutAction } from "../lib/conversation-layout";

type Drop = { pane: number; edge: DockEdge };
/** Pointer capture keeps internal pane drags inside WebView2 instead of its OS file-drop loop. */
export function useConversationDrag(
  layout: ConversationLayout,
  onAction: (action: LayoutAction) => void,
  allowDock: boolean,
) {
  const latest = useRef({ layout, onAction, allowDock });
  latest.current = { layout, onAction, allowDock };
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  return (event: ReactPointerEvent) => {
    if (
      event.button !== 0 ||
      (event.target as Element).closest("[data-conversation-no-drag]")
    )
      return;
    const source = (event.target as Element).closest<HTMLElement>(
      "[data-conversation-view], [data-conversation-room]",
    );
    if (!source) return;
    cleanup.current?.();
    const viewId = source.dataset.conversationView,
      roomId = source.dataset.conversationRoom;
    const start = { x: event.clientX, y: event.clientY },
      pointerId = event.pointerId;
    let dragging = false,
      drop: Drop | null = null;
    // Suppresses only the click that follows a completed drag. It is armed in
    // finish() and cleared with the deferred listener removal, so a leaked
    // listener can never swallow later clicks on a stale dragging flag.
    let suppressing = false;
    const hint = document.createElement("div");
    hint.className = "conversation-dock__hint";
    hint.setAttribute("aria-hidden", "true");
    source.setPointerCapture(pointerId);
    const clearHint = () => {
      hint.remove();
    };
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (
        !dragging &&
        Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < 6
      )
        return;
      dragging = true;
      moveEvent.preventDefault();
      clearHint();
      drop = null;
      const target = document.elementFromPoint(
        moveEvent.clientX,
        moveEvent.clientY,
      );
      const { layout, allowDock } = latest.current;
      const paneElement = target?.closest<HTMLElement>(
        "[data-conversation-pane]",
      );
      if (!paneElement || !allowDock || layout.panes.length >= MAX_PANES) return;
      const pane = Number(paneElement.dataset.conversationPane),
        rect = paneElement.getBoundingClientRect();
      const x = (moveEvent.clientX - rect.left) / rect.width,
        y = (moveEvent.clientY - rect.top) / rect.height,
        closest = Math.min(x, 1 - x, y, 1 - y);
      if (closest > 0.25) return;
      const edge: DockEdge =
        closest === x
          ? "left"
          : closest === 1 - x
            ? "right"
            : closest === y
              ? "top"
              : "bottom";
      if (
        viewId &&
        layout.panes[pane]?.length === 1 &&
        layout.panes[pane][0] === viewId
      )
        return;
      drop = { pane, edge };
      const horizontal = edge === "left" || edge === "right";
      hint.textContent = "Split here";
      hint.style.cssText = `position:fixed;left:${rect.left + (edge === "right" ? rect.width / 2 : 0) + 4}px;top:${rect.top + (edge === "bottom" ? rect.height / 2 : 0) + 4}px;width:${rect.width / (horizontal ? 2 : 1) - 8}px;height:${rect.height / (horizontal ? 1 : 2) - 8}px;z-index:1100`;
      document.body.append(hint);
    };
    const suppressClick = (click: MouseEvent) => {
      if (suppressing) {
        click.preventDefault();
        click.stopImmediatePropagation();
      }
    };
    const finish = () => {
      const wasDragging = dragging;
      dragging = false;
      clearHint();
      if (source.hasPointerCapture(pointerId))
        source.releasePointerCapture(pointerId);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("blur", cancel);
      suppressing = wasDragging;
      window.setTimeout(() => {
        suppressing = false;
        document.removeEventListener("click", suppressClick, true);
      }, 0);
      cleanup.current = null;
    };
    const up = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      if (dragging) move(upEvent);
      const target = drop;
      const wasDragging = dragging;
      finish();
      if (!wasDragging || !target) return;
      const { onAction } = latest.current;
      if (viewId)
        onAction({
          type: "dock",
          id: viewId,
          pane: target.pane,
          edge: target.edge,
        });
      else if (roomId)
        onAction({
          type: "dock",
          view: {
            id: `view-${crypto.randomUUID()}`,
            kind: "conversation",
            conversationId: roomId,
          },
          pane: target.pane,
          edge: target.edge,
        });
    };
    const cancel = () => finish();
    const escape = (key: KeyboardEvent) => {
      if (key.key === "Escape") {
        key.preventDefault();
        finish();
      }
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("keydown", escape, true);
    document.addEventListener("click", suppressClick, true);
    window.addEventListener("blur", cancel);
    cleanup.current = finish;
  };
}

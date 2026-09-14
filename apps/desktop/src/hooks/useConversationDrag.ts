import {
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ConversationLayout } from "@fable/protocol";
import { MAX_PANES, type DockEdge, type LayoutAction } from "../lib/conversation-layout";

type Drop =
  | { kind: "tab"; pane: number; index: number }
  | { kind: "pane"; pane: number; edge: DockEdge };
/** Pointer capture keeps internal tab drags inside WebView2 instead of its OS file-drop loop. */
export function useConversationDrag(
  layout: ConversationLayout,
  onAction: (action: LayoutAction) => void,
  onOpen: (id: string, newTab: boolean) => void,
  allowDock: boolean,
) {
  const latest = useRef({ layout, onAction, onOpen, allowDock });
  latest.current = { layout, onAction, onOpen, allowDock };
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
      drop: Drop | null = null,
      markedTab: Element | null = null;
    const hint = document.createElement("div");
    hint.className = "conversation-dock__hint";
    hint.setAttribute("aria-hidden", "true");
    source.setPointerCapture(pointerId);
    const clearHint = () => {
      hint.remove();
      markedTab?.classList.remove("conversation-tabs--drop-target");
      markedTab = null;
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
      const tabs = target?.closest("[data-conversation-tabs]");
      if (tabs) {
        const tabId = target?.closest<HTMLElement>("[data-conversation-tab]")
          ?.dataset.conversationTab;
        const pane = tabId
          ? layout.panes.findIndex((ids) => ids.includes(tabId))
          : layout.activePane;
        if (pane >= 0) {
          drop = {
            kind: "tab",
            pane,
            index: tabId ? layout.panes[pane].indexOf(tabId) : 999,
          };
          markedTab = tabs;
          tabs.classList.add("conversation-tabs--drop-target");
        }
        return;
      }
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
      drop = { kind: "pane", pane, edge };
      const horizontal = edge === "left" || edge === "right";
      hint.textContent = "Split here";
      hint.style.cssText = `position:fixed;left:${rect.left + (edge === "right" ? rect.width / 2 : 0) + 4}px;top:${rect.top + (edge === "bottom" ? rect.height / 2 : 0) + 4}px;width:${rect.width / (horizontal ? 2 : 1) - 8}px;height:${rect.height / (horizontal ? 1 : 2) - 8}px;z-index:1100`;
      document.body.append(hint);
    };
    const suppressClick = (click: MouseEvent) => {
      if (dragging) {
        click.preventDefault();
        click.stopImmediatePropagation();
      }
    };
    const finish = () => {
      clearHint();
      if (source.hasPointerCapture(pointerId))
        source.releasePointerCapture(pointerId);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("blur", cancel);
      window.setTimeout(
        () => document.removeEventListener("click", suppressClick, true),
        0,
      );
      cleanup.current = null;
    };
    const up = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      if (dragging) move(upEvent);
      const target = drop;
      finish();
      if (!dragging || !target) return;
      const { onAction, onOpen } = latest.current;
      if (target.kind === "tab") {
        if (viewId)
          onAction({
            type: "move",
            id: viewId,
            pane: target.pane,
            index: target.index,
          });
        else if (roomId) onOpen(roomId, true);
      } else if (viewId)
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

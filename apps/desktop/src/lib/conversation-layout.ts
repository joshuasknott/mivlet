import type {
  ConversationLayout,
  ConversationLayoutNode,
  WorkspaceView,
  ObjectReference,
} from "@fable/protocol";

/** View identity resolves an existing object; it never creates a conversation. */
export function referenceForView(workspaceId: string, view: WorkspaceView): ObjectReference {
  return view.kind === "conversation"
    ? { workspaceId, kind: "conversation", id: view.conversationId }
    : { workspaceId, kind: "file", id: JSON.stringify([view.agentId, view.output]) };
}

export type DockEdge = "left" | "right" | "top" | "bottom";
export const emptyLayout = (): ConversationLayout => ({
  version: 2,
  panes: [[]],
  views: [],
  active: [null],
  activePane: 0,
  tree: { kind: "pane", pane: 0 },
  closed: [],
});
export type LayoutAction =
  | {
      type: "open" | "navigate";
      view: WorkspaceView;
      pane?: number;
      duplicate?: boolean;
    }
  | { type: "activate" | "close"; id: string }
  | { type: "move"; id: string; pane: number; index: number }
  | {
      type: "dock";
      id?: string;
      view?: WorkspaceView;
      pane: number;
      edge: DockEdge;
    }
  | { type: "single" }
  | { type: "resize"; path: number[]; ratio: number }
  | { type: "reopen" };

function compact(layout: ConversationLayout): ConversationLayout {
  const keep = layout.panes.flatMap((ids, i) => (ids.length ? [i] : []));
  if (!keep.length) return { ...emptyLayout(), closed: layout.closed };
  const prune = (
    node: ConversationLayoutNode,
  ): ConversationLayoutNode | null => {
    if (node.kind === "pane")
      return keep.includes(node.pane)
        ? { kind: "pane", pane: keep.indexOf(node.pane) }
        : null;
    const a = prune(node.children[0]),
      b = prune(node.children[1]);
    return a && b ? { ...node, children: [a, b] } : (a ?? b);
  };
  return {
    ...layout,
    panes: keep.map((i) => layout.panes[i]),
    active: keep.map((i) => layout.active[i]),
    activePane: Math.max(0, keep.indexOf(layout.activePane)),
    tree: prune(layout.tree)!,
  };
}

/** View changes never dispatch, stop, or duplicate an execution. */
export function reduceLayout(
  state: ConversationLayout,
  action: LayoutAction,
): ConversationLayout {
  const next: ConversationLayout = {
    ...state,
    panes: state.panes.map((ids) => [...ids]),
    views: [...state.views],
    active: [...state.active],
    closed: [...state.closed],
  };
  const owner = (id: string) => next.panes.findIndex((ids) => ids.includes(id));
  const activate = (id: string) => {
    const pane = owner(id);
    if (pane >= 0) {
      next.active[pane] = id;
      next.activePane = pane;
    }
  };
  const remove = (id: string) => {
    const pane = owner(id);
    if (pane < 0) return;
    const index = next.panes[pane].indexOf(id);
    next.panes[pane].splice(index, 1);
    if (next.active[pane] === id)
      next.active[pane] =
        next.panes[pane][Math.min(index, next.panes[pane].length - 1)] ?? null;
  };
  const remember = (view: WorkspaceView) => {
    next.closed = [
      ...next.closed.filter((old) => old.id !== view.id),
      view,
    ].slice(-20);
  };
  const add = (view: WorkspaceView, pane: number) => {
    if (
      next.views.length >= 40 ||
      next.views.some((old) => old.id === view.id) ||
      !next.panes[pane]
    )
      return false;
    next.views.push(view);
    next.panes[pane].push(view.id);
    next.closed = next.closed.filter((old) => old.id !== view.id);
    activate(view.id);
    return true;
  };
  switch (action.type) {
    case "open":
    case "navigate": {
      const pane = action.pane ?? next.activePane;
      if (!next.panes[pane]) return state;
      const existing =
        !action.duplicate &&
        next.views.find(
          (view) =>
            JSON.stringify(referenceForView("", view)) === JSON.stringify(referenceForView("", action.view)),
        );
      if (existing) {
        activate(existing.id);
        break;
      }
      if (action.type === "navigate") {
        const old = next.views.find((view) => view.id === next.active[pane]);
        if (old) {
          remove(old.id);
          next.views = next.views.filter((view) => view.id !== old.id);
          remember(old);
        }
      }
      add(action.view, pane);
      break;
    }
    case "activate":
      activate(action.id);
      break;
    case "close": {
      const view = next.views.find((view) => view.id === action.id);
      if (!view) return state;
      remove(view.id);
      next.views = next.views.filter((old) => old.id !== view.id);
      remember(view);
      break;
    }
    case "move": {
      if (owner(action.id) < 0 || !next.panes[action.pane]) return state;
      remove(action.id);
      next.panes[action.pane].splice(
        Math.max(0, Math.min(action.index, next.panes[action.pane].length)),
        0,
        action.id,
      );
      activate(action.id);
      break;
    }
    case "dock": {
      if (next.panes.length >= 8 || !next.panes[action.pane]) return state;
      const source = action.id
        ? next.views.find((view) => view.id === action.id)
        : action.view;
      if (
        !source ||
        (action.id &&
          owner(action.id) === action.pane &&
          next.panes[action.pane].length === 1)
      )
        return state;
      const pane = next.panes.length;
      next.panes.push([]);
      next.active.push(null);
      if (action.id) {
        remove(action.id);
        next.panes[pane].push(action.id);
        activate(action.id);
      } else if (!add(source, pane)) return state;
      const before = action.edge === "left" || action.edge === "top";
      const insert = (node: ConversationLayoutNode): ConversationLayoutNode =>
        node.kind === "pane"
          ? node.pane === action.pane
            ? {
                kind: "split",
                axis:
                  action.edge === "left" || action.edge === "right"
                    ? "row"
                    : "column",
                ratio: 0.5,
                children: before
                  ? [{ kind: "pane", pane }, node]
                  : [node, { kind: "pane", pane }],
              }
            : node
          : {
              ...node,
              children: [insert(node.children[0]), insert(node.children[1])],
            };
      next.tree = insert(next.tree);
      break;
    }
    case "single":
      next.panes = [next.panes.flat()];
      next.active = [next.active[next.activePane]];
      next.activePane = 0;
      next.tree = { kind: "pane", pane: 0 };
      break;
    case "resize": {
      if (!Number.isFinite(action.ratio)) return state;
      const resize = (
        node: ConversationLayoutNode,
        depth: number,
      ): ConversationLayoutNode => {
        if (node.kind === "pane") return node;
        if (depth === action.path.length)
          return { ...node, ratio: Math.max(0.2, Math.min(0.8, action.ratio)) };
        const children: [ConversationLayoutNode, ConversationLayoutNode] = [
          ...node.children,
        ];
        const index = action.path[depth];
        if (index !== 0 && index !== 1) return node;
        children[index] = resize(children[index], depth + 1);
        return { ...node, children };
      };
      next.tree = resize(next.tree, 0);
      break;
    }
    case "reopen": {
      const view = next.closed.pop();
      if (view && !add(view, next.activePane)) next.closed.push(view);
      break;
    }
  }
  return compact(next);
}

/** v1 used two fixed panes. Preserve its tabs in the new single-pane default. */
export function restoreLayout(
  layout: ConversationLayout | null,
  conversationIds: Set<string>,
): ConversationLayout {
  if (!layout || ![1, 2].includes(layout.version)) return emptyLayout();
  const views = layout.views
    .filter((view) => conversationIds.has(view.conversationId))
    .slice(0, 40);
  const ids = new Set(views.map((view) => view.id));
  const panes = layout.version === 2 ? layout.panes : [layout.panes.flat()];
  const seen = new Set<string>();
  const filtered = panes.map((pane) =>
    pane.filter((id) => ids.has(id) && !seen.has(id) && Boolean(seen.add(id))),
  );
  const active = filtered.map((pane, i) =>
    pane.includes(layout.active[i] ?? "")
      ? layout.active[i]
      : (pane[0] ?? null),
  );
  return compact({
    ...emptyLayout(),
    views: views.filter((view) => seen.has(view.id)),
    panes: filtered,
    active,
    activePane: layout.version === 2 ? layout.activePane : 0,
    tree: layout.version === 2 ? layout.tree : { kind: "pane", pane: 0 },
    closed: layout.closed
      .filter((view) => conversationIds.has(view.conversationId))
      .slice(-20),
  });
}

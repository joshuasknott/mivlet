import type { ConversationLayout, WorkspaceView } from "@fable/protocol";

export const emptyLayout = (): ConversationLayout => ({
  version: 1,
  panes: [[], []],
  views: [],
  active: [null, null],
  activePane: 0,
  split: false,
  ratio: 0.5,
  closed: [],
});
export type LayoutAction =
  | { type: "open"; view: WorkspaceView; pane?: 0 | 1; duplicate?: boolean }
  | { type: "activate"; id: string }
  | { type: "close"; id: string }
  | { type: "move"; id: string; pane: 0 | 1; index: number }
  | { type: "split"; view?: WorkspaceView }
  | { type: "swap" }
  | { type: "single" }
  | { type: "resize"; ratio: number }
  | { type: "reopen" };

/** Pure view state. No branch in this reducer can dispatch or cancel execution. */
export function reduceLayout(
  state: ConversationLayout,
  action: LayoutAction,
): ConversationLayout {
  const next: ConversationLayout = {
    ...state,
    panes: [[...state.panes[0]], [...state.panes[1]]],
    views: [...state.views],
    active: [...state.active],
    closed: [...state.closed],
  };
  const owner = (id: string): 0 | 1 | undefined =>
    next.panes[0].includes(id) ? 0 : next.panes[1].includes(id) ? 1 : undefined;
  const activate = (id: string) => {
    const pane = owner(id);
    if (pane !== undefined) {
      next.active[pane] = id;
      next.activePane = pane;
      if (pane === 1) next.split = true;
    }
  };
  const remove = (id: string) => {
    const pane = owner(id);
    if (pane === undefined) return;
    const index = next.panes[pane].indexOf(id);
    next.panes[pane].splice(index, 1);
    if (next.active[pane] === id)
      next.active[pane] =
        next.panes[pane][Math.min(index, next.panes[pane].length - 1)] ?? null;
  };
  const open = (view: WorkspaceView, pane: 0 | 1, duplicate: boolean) => {
    const existing =
      !duplicate &&
      next.views.find(
        (current) =>
          current.kind === view.kind &&
          current.conversationId === view.conversationId &&
          (view.kind !== "artifact" ||
            (current.kind === "artifact" && current.output === view.output)),
      );
    if (existing) {
      activate(existing.id);
      return;
    }
    if (
      next.views.length >= 40 ||
      next.views.some((current) => current.id === view.id)
    )
      return;
    next.views.push(view);
    next.panes[pane].push(view.id);
    next.closed = next.closed.filter((current) => current.id !== view.id);
    activate(view.id);
  };
  switch (action.type) {
    case "open":
      open(
        action.view,
        action.pane ?? state.activePane,
        action.duplicate ?? false,
      );
      break;
    case "activate":
      activate(action.id);
      break;
    case "close": {
      const view = next.views.find((view) => view.id === action.id);
      if (!view) return state;
      remove(action.id);
      next.views = next.views.filter((view) => view.id !== action.id);
      next.closed = [
        ...next.closed.filter((old) => old.id !== view.id),
        view,
      ].slice(-20);
      if (!next.active[next.activePane])
        next.activePane = next.activePane === 0 ? 1 : 0;
      break;
    }
    case "move": {
      if (owner(action.id) === undefined) return state;
      remove(action.id);
      const pane = next.panes[action.pane];
      pane.splice(
        Math.max(0, Math.min(action.index, pane.length)),
        0,
        action.id,
      );
      activate(action.id);
      break;
    }
    case "split": {
      next.split = true;
      if (action.view) open(action.view, 1, true);
      else if (!next.panes[1].length && next.panes[0].length > 1) {
        const id = next.active[0] ?? next.panes[0].at(-1)!;
        remove(id);
        next.panes[1].push(id);
        activate(id);
      }
      break;
    }
    case "swap":
      next.panes = [next.panes[1], next.panes[0]];
      next.active = [next.active[1], next.active[0]];
      next.activePane = next.activePane === 0 ? 1 : 0;
      next.ratio = 1 - next.ratio;
      break;
    case "single": {
      const active = next.active[next.activePane];
      next.panes = [[...next.panes[0], ...next.panes[1]], []];
      next.active = [active ?? next.panes[0][0] ?? null, null];
      next.activePane = 0;
      next.split = false;
      break;
    }
    case "resize":
      next.ratio = Math.max(0.25, Math.min(0.75, action.ratio));
      break;
    case "reopen": {
      const view = next.closed.pop();
      if (view) open(view, next.activePane, true);
      break;
    }
  }
  if (!next.split) next.activePane = 0;
  return next;
}

export function restoreLayout(
  layout: ConversationLayout | null,
  conversationIds: Set<string>,
): ConversationLayout {
  if (!layout || layout.version !== 1) return emptyLayout();
  const views = layout.views.filter((view) =>
    conversationIds.has(view.conversationId),
  );
  const ids = new Set(views.map((view) => view.id));
  const panes: [string[], string[]] = [
    layout.panes[0].filter((id) => ids.has(id)),
    layout.panes[1].filter((id) => ids.has(id)),
  ];
  const active = panes.map((pane, index) =>
    pane.includes(layout.active[index] ?? "")
      ? layout.active[index]
      : (pane[0] ?? null),
  ) as [string | null, string | null];
  return {
    ...layout,
    views,
    panes,
    active,
    closed: layout.closed.filter((view) =>
      conversationIds.has(view.conversationId),
    ),
    ratio: Math.max(0.25, Math.min(0.75, layout.ratio)),
  };
}

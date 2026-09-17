import type { ConversationLayout } from "@mivlet/protocol";
import { describe, expect, it } from "vitest";
import {
  emptyLayout,
  reduceLayout,
  restoreLayout,
} from "./conversation-layout";
const view = (id: string, conversationId = `room-${id}`) => ({
  id,
  kind: "conversation" as const,
  conversationId,
});
const opened = (...ids: string[]) =>
  ids.reduce(
    (layout, id) => reduceLayout(layout, { type: "navigate", view: view(id) }),
    emptyLayout(),
  );
describe("conversation view layout", () => {
  it("restores only the selected legacy tab without retaining closed views", () => {
    const saved = { ...emptyLayout(), panes: [["a", "b"]], views: [view("a"), view("b")], active: ["b"], closed: [view("c")] };
    const ids = new Set(["room-a", "room-b", "room-c"]);
    const restored = restoreLayout(saved, ids);
    expect(restored.panes).toEqual([["b"]]);
    expect(restored.views).toEqual([view("b")]);
    expect(restored.closed).toEqual([]);
    expect(saved.views).toHaveLength(2);
    expect(ids.size).toBe(3);
  });
  it("starts with one pane and ordinary navigation replaces the visible conversation", () => {
    const layout = reduceLayout(opened("a"), {
      type: "navigate",
      view: view("b"),
    });
    expect(layout.panes).toEqual([["b"]]);
    expect(layout.closed).toEqual([]);
    expect(layout.views).toEqual([view("b")]);
  });
  it("docks, resizes and restores stable pane IDs", () => {
    let layout = reduceLayout(opened("a"), { type: "dock", view: view("b"), pane: 0, edge: "right" });
    layout = reduceLayout(layout, { type: "resize", path: [], ratio: 0.64 });
    expect(layout.tree.kind === "split" && layout.tree.ratio).toBe(0.64);
    expect(restoreLayout(layout, new Set(["room-a", "room-b"]))).toEqual(layout);
  });
  it("allows three panes and refuses a fourth without losing its views", () => {
    let layout = opened("a");
    layout = reduceLayout(layout, {
      type: "dock",
      view: view("v1"),
      pane: 0,
      edge: "right",
    });
    layout = reduceLayout(layout, {
      type: "dock",
      view: view("v2"),
      pane: 1,
      edge: "bottom",
    });
    expect(layout.panes).toHaveLength(3);
    expect(layout.views).toHaveLength(3);
    // A dock that would exceed the cap returns the identical state; the
    // existing panes, active views and split tree are untouched.
    const refused = reduceLayout(layout, {
      type: "dock",
      view: view("fourth"),
      pane: 2,
      edge: "left",
    });
    expect(refused).toBe(layout);
    expect(refused.tree).toEqual({
      kind: "split",
      axis: "row",
      ratio: 0.5,
      children: [
        { kind: "pane", pane: 0 },
        {
          kind: "split",
          axis: "column",
          ratio: 0.5,
          children: [
            { kind: "pane", pane: 1 },
            { kind: "pane", pane: 2 },
          ],
        },
      ],
    });
    layout = reduceLayout(layout, { type: "close", id: "v1" });
    expect(layout.panes).toHaveLength(2);
    expect(layout.tree).toEqual({
      kind: "split",
      axis: "row",
      ratio: 0.5,
      children: [
        { kind: "pane", pane: 0 },
        { kind: "pane", pane: 1 },
      ],
    });
    expect(
      restoreLayout(
        layout,
        new Set(
          [...layout.views, ...layout.closed].map(
            (view) => view.conversationId,
          ),
        ),
      ),
    ).toEqual(layout);
  });
  it("limits restored panes and clamps the active view", () => {
    const saved: ConversationLayout = {
      version: 2,
      panes: [["a"], ["b"], ["c"], ["d"]],
      views: [view("a"), view("b"), view("c"), view("d")],
      active: ["a", "b", "c", "d"],
      activePane: 3,
      tree: {
        kind: "split",
        axis: "row",
        ratio: 0.5,
        children: [
          {
            kind: "split",
            axis: "column",
            ratio: 0.5,
            children: [
              { kind: "pane", pane: 0 },
              { kind: "pane", pane: 1 },
            ],
          },
          {
            kind: "split",
            axis: "column",
            ratio: 0.5,
            children: [
              { kind: "pane", pane: 2 },
              { kind: "pane", pane: 3 },
            ],
          },
        ],
      },
      closed: [],
    };
    const restored = restoreLayout(
      saved,
      new Set(["room-a", "room-b", "room-c", "room-d"]),
    );
    // Hidden views are discarded without changing saved conversations.
    expect(restored.panes).toEqual([["a"], ["b"], ["c"]]);
    expect(restored.views.map((item) => item.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    // The active pane clamps to a kept pane and the tree prunes the folded leaf.
    expect(restored.activePane).toBe(2);
    expect(restored.tree).toEqual({
      kind: "split",
      axis: "row",
      ratio: 0.5,
      children: [
        {
          kind: "split",
          axis: "column",
          ratio: 0.5,
          children: [
            { kind: "pane", pane: 0 },
            { kind: "pane", pane: 1 },
          ],
        },
        { kind: "pane", pane: 2 },
      ],
    });
  });
  it("normal opening activates an existing view; dragging history can show the same conversation twice", () => {
    let layout = opened("a");
    layout = reduceLayout(layout, {
      type: "navigate",
      view: view("other", "room-a"),
    });
    expect(layout.views).toHaveLength(1);
    layout = reduceLayout(layout, {
      type: "dock",
      view: view("duplicate", "room-a"),
      pane: 0,
      edge: "bottom",
    });
    expect(layout.views.map((view) => view.conversationId)).toEqual([
      "room-a",
      "room-a",
    ]);
    expect(
      reduceLayout(layout, { type: "close", id: "duplicate" }).views,
    ).toEqual([view("a")]);
  });
  it("migrates legacy layouts without retaining hidden tabs", () => {
    const legacy = {
      version: 1,
      panes: [["a"], ["b"]],
      active: ["a", "b"],
      activePane: 1,
      split: true,
      ratio: 0.5,
      views: [view("a"), view("b")],
      closed: [],
    };
    const layout = restoreLayout(
      legacy as unknown as ConversationLayout,
      new Set(["room-a", "room-b"]),
    );
    expect(layout.version).toBe(2);
    expect(layout.panes).toEqual([["b"]]);
    expect(layout.tree).toEqual({ kind: "pane", pane: 0 });
  });
  it("restores only the current workspace and collapses removed branches", () => {
    let layout = reduceLayout(opened("a"), {
      type: "dock",
      view: view("private", "other-workspace"),
      pane: 0,
      edge: "top",
    });
    layout = reduceLayout(layout, { type: "resize", path: [], ratio: 3 });
    expect(layout.tree.kind === "split" && layout.tree.ratio).toBe(0.8);
    expect(reduceLayout(layout, { type: "resize", path: [], ratio: NaN })).toBe(
      layout,
    );
    const restored = restoreLayout(layout, new Set(["room-a"]));
    expect(restored.panes).toEqual([["a"]]);
    expect(restored.views).toEqual([view("a")]);
    expect(restoreLayout(layout, new Set())).toEqual(emptyLayout());
  });
  it("closing a pane clears its view and merging retains only the active conversation", () => {
    const closed = reduceLayout(opened("a"), { type: "close", id: "a" });
    expect(closed.panes).toEqual([[]]);
    expect(closed.views).toEqual([]);
    expect(closed.closed).toEqual([]);
    const split = reduceLayout(opened("a"), {
      type: "dock",
      view: view("b"),
      pane: 0,
      edge: "right",
    });
    expect(reduceLayout(split, { type: "single" }).panes).toEqual([["b"]]);
  });
});

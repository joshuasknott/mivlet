import type { ConversationLayout } from "@fable/protocol";
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
    (layout, id) => reduceLayout(layout, { type: "open", view: view(id) }),
    emptyLayout(),
  );
describe("conversation view layout", () => {
  it("starts with one pane and ordinary navigation replaces the active tab", () => {
    const layout = reduceLayout(opened("a"), {
      type: "navigate",
      view: view("b"),
    });
    expect(layout.panes).toEqual([["b"]]);
    expect(layout.closed.map((view) => view.id)).toEqual(["a"]);
    expect(reduceLayout(layout, { type: "reopen" }).panes).toEqual([
      ["b", "a"],
    ]);
  });
  it("reorders, docks, resizes and restores stable IDs without duplicating conversations", () => {
    let layout = reduceLayout(opened("a", "b", "c"), {
      type: "move",
      id: "c",
      pane: 0,
      index: 0,
    });
    expect(layout.panes[0]).toEqual(["c", "a", "b"]);
    layout = reduceLayout(layout, {
      type: "dock",
      id: "b",
      pane: 0,
      edge: "right",
    });
    layout = reduceLayout(layout, { type: "resize", path: [], ratio: 0.64 });
    expect(layout.tree).toEqual({
      kind: "split",
      axis: "row",
      ratio: 0.64,
      children: [
        { kind: "pane", pane: 0 },
        { kind: "pane", pane: 1 },
      ],
    });
    expect(
      restoreLayout(
        JSON.parse(JSON.stringify(layout)),
        new Set(["room-a", "room-b", "room-c"]),
      ),
    ).toEqual(layout);
    layout = reduceLayout(layout, { type: "move", id: "b", pane: 0, index: 1 });
    expect(layout.panes).toEqual([["c", "b", "a"]]);
    expect(layout.tree).toEqual({ kind: "pane", pane: 0 });
  });
  it("allows eight panes with nested rows and columns and refuses a ninth", () => {
    let layout = opened("a");
    for (let i = 1; i < 8; i++)
      layout = reduceLayout(layout, {
        type: "dock",
        view: view(`v${i}`),
        pane: i - 1,
        edge: i % 2 ? "right" : "bottom",
      });
    expect(layout.panes).toHaveLength(8);
    expect(layout.views).toHaveLength(8);
    expect(
      reduceLayout(layout, {
        type: "dock",
        view: view("ninth"),
        pane: 7,
        edge: "left",
      }),
    ).toBe(layout);
    layout = reduceLayout(layout, { type: "close", id: "v3" });
    expect(layout.panes).toHaveLength(7);
    expect(layout.activePane).toBe(6);
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
  it("normal opening activates an existing view; dragging history can show the same conversation twice", () => {
    let layout = opened("a");
    layout = reduceLayout(layout, {
      type: "open",
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
  it("migrates fixed two-pane layouts to one pane while retaining tabs", () => {
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
    expect(layout.panes).toEqual([["a", "b"]]);
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
  it("closing the last tab keeps it reopenable and merging panes keeps every view", () => {
    const closed = reduceLayout(opened("a"), { type: "close", id: "a" });
    expect(closed.panes).toEqual([[]]);
    expect(reduceLayout(closed, { type: "reopen" }).views).toEqual([view("a")]);
    const split = reduceLayout(opened("a"), {
      type: "dock",
      view: view("b"),
      pane: 0,
      edge: "right",
    });
    expect(reduceLayout(split, { type: "single" }).panes).toEqual([["a", "b"]]);
  });
});

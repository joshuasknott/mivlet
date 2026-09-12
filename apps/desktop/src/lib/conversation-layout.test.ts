import { describe, expect, it } from "vitest";
import {
  emptyLayout,
  reduceLayout,
  restoreLayout,
} from "./conversation-layout";

describe("conversation view layout", () => {
  it("opens, reorders, splits, resizes, swaps, closes and restores stable durable IDs", () => {
    let layout = emptyLayout();
    for (const id of ["a", "b", "c"])
      layout = reduceLayout(layout, {
        type: "open",
        view: { id, kind: "conversation", conversationId: `room-${id}` },
      });
    layout = reduceLayout(layout, { type: "move", id: "c", pane: 0, index: 0 });
    expect(layout.panes[0]).toEqual(["c", "a", "b"]);
    layout = reduceLayout(layout, {
      type: "split",
      view: {
        id: "other-view",
        kind: "conversation",
        conversationId: "room-a",
      },
    });
    layout = reduceLayout(layout, { type: "resize", ratio: 0.64 });
    layout = reduceLayout(layout, { type: "swap" });
    expect(layout.panes[0]).toEqual(["other-view"]);
    expect(layout.ratio).toBeCloseTo(0.36);
    layout = reduceLayout(layout, { type: "close", id: "other-view" });
    expect(layout.views.some((view) => view.conversationId === "room-a")).toBe(
      true,
    );
    layout = reduceLayout(layout, { type: "reopen" });
    expect(
      layout.views.find((view) => view.id === "other-view")?.conversationId,
    ).toBe("room-a");
    const restored = restoreLayout(
      JSON.parse(JSON.stringify(layout)),
      new Set(["room-a", "room-b", "room-c"]),
    );
    expect(restored).toEqual(layout);
    layout = reduceLayout(restored, { type: "single" });
    expect(layout.panes[1]).toEqual([]);
    expect(layout.views).toHaveLength(4);
    expect(layout.split).toBe(false);
  });
  it("normal opening activates an existing view, while explicit split duplicates only the view", () => {
    let layout = reduceLayout(emptyLayout(), {
      type: "open",
      view: { id: "a", kind: "conversation", conversationId: "same" },
    });
    layout = reduceLayout(layout, {
      type: "open",
      view: { id: "b", kind: "conversation", conversationId: "same" },
    });
    expect(layout.views.map((view) => view.id)).toEqual(["a"]);
    layout = reduceLayout(layout, {
      type: "split",
      view: { id: "b", kind: "conversation", conversationId: "same" },
    });
    expect(layout.views.map((view) => view.conversationId)).toEqual([
      "same",
      "same",
    ]);
  });
  it("restores only conversations belonging to the current workspace and bounds resizing", () => {
    let layout = reduceLayout(emptyLayout(), {
      type: "open",
      view: {
        id: "private",
        kind: "conversation",
        conversationId: "other-workspace",
      },
    });
    layout = reduceLayout(layout, { type: "resize", ratio: 3 });
    expect(layout.ratio).toBe(0.75);
    expect(restoreLayout(layout, new Set()).views).toEqual([]);
  });
});

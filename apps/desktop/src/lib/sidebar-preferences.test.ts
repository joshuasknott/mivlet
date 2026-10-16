import { describe, expect, it } from "vitest";
import { DEFAULT_SIDEBAR_PREFERENCES, moveSidebarItem, normalizeSidebarPreferences, orderSidebarItems } from "./sidebar-preferences";
import { shellStateFromRuntimeSnapshot, shellStateToRuntimeSnapshot } from "./persistence";
import { defaultShellState } from "../hooks/shell-runtime/defaults";

describe("workspace sidebar preferences", () => {
  it("round-trips pins, manual order and collapsed sections through the existing snapshot", () => {
    const preferences = { ...DEFAULT_SIDEBAR_PREFERENCES, pinned: [{ kind: "project" as const, id: "launch" }, { kind: "agent" as const, id: "mira" }],
      agentSort: "manual" as const, agentOrder: ["mira", "nova"], projectsCollapsed: true };
    const snapshot = shellStateToRuntimeSnapshot({ ...defaultShellState, sidebarPreferences: preferences });
    expect(shellStateFromRuntimeSnapshot(snapshot, defaultShellState).sidebarPreferences).toEqual(preferences);
    delete snapshot.sidebarPreferences;
    // Never inherit another account's preferences from a fallback shell.
    expect(shellStateFromRuntimeSnapshot(snapshot, { ...defaultShellState, sidebarPreferences: preferences }).sidebarPreferences)
      .toEqual(DEFAULT_SIDEBAR_PREFERENCES);
  });

  it("rejects chat pins, invalid refs and duplicates without losing stable ordering", () => {
    expect(normalizeSidebarPreferences({
      pinned: [{ kind: "conversation", id: "project-chat" }, { kind: "project", id: "a" }, { kind: "project", id: "a" },
        { kind: "agent", id: "a" }, { kind: "agent", id: "" }, null],
      projectSort: "anything", projectOrder: ["b", "a", "b", 4], projectsCollapsed: "false",
    })).toEqual({ ...DEFAULT_SIDEBAR_PREFERENCES, pinned: [{ kind: "project", id: "a" }, { kind: "agent", id: "a" }], projectOrder: ["b", "a"] });
  });

  it("uses activity by default, preserves manual order and includes newly created items", () => {
    const items = [{ id: "older" }, { id: "newer" }, { id: "new" }];
    const activity = new Map([["older", 10], ["newer", 20]]);
    expect(orderSidebarItems(items, "recent", [], activity).map((item) => item.id)).toEqual(["newer", "older", "new"]);
    expect(orderSidebarItems(items, "manual", ["older", "newer"], activity)).toEqual(items);
    expect(moveSidebarItem(items, 1, -1).map((item) => item.id)).toEqual(["newer", "older", "new"]);
    expect(moveSidebarItem(items, 0, -1)).toEqual(items);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { defaultShellState } from "../hooks/shell-runtime/defaults";
import { STORAGE_KEY } from "./constants";
import {
  persistShellState,
  readPersistedShellState,
  shellStateFromRuntimeSnapshot,
  shellStateToRuntimeSnapshot
} from "./persistence";

describe("conversation shell persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips the supported local state without orchestration collections", () => {
    const snapshot = shellStateToRuntimeSnapshot({
      ...defaultShellState,
      composerValue: "Continue this conversation",
      connectedBackendIds: ["xai"]
    });

    expect(snapshot).not.toHaveProperty("schedules");
    expect(snapshot).not.toHaveProperty("goals");
    expect(snapshot).not.toHaveProperty("plans");
    expect(snapshot).not.toHaveProperty("workflows");
    expect(snapshot).not.toHaveProperty("missions");
    expect(shellStateFromRuntimeSnapshot(snapshot, defaultShellState)).toMatchObject({
      composerValue: "Continue this conversation",
      connectedBackendIds: ["xai"]
    });
  });

  it("normalizes retired navigation into Settings while preserving the draft", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...defaultShellState,
      activeItem: "Schedules",
      composerValue: "Keep this draft"
    }));

    expect(readPersistedShellState(defaultShellState)).toMatchObject({
      activeItem: "Settings",
      composerValue: "Keep this draft"
    });
  });

  it("stores only documented non-secret shell state", () => {
    persistShellState({
      ...defaultShellState,
      connectedBackendIds: ["xai"]
    });
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");

    expect(stored.connectedBackendIds).toEqual(["xai"]);
    expect(JSON.stringify(stored)).not.toMatch(/apiKey|secret|credential/i);
    expect(stored).not.toHaveProperty("schedules");
  });
});

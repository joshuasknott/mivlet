import { beforeEach, describe, expect, it } from "vitest";
import { defaultShellState } from "../hooks/shell-runtime/defaults";
import { STORAGE_KEY } from "./constants";
import { avatarVariant, createAvatarSeed } from "./blob-avatar";
import {
  persistShellState,
  readPersistedShellState,
  shellStateFromRuntimeSnapshot,
  shellStateToRuntimeSnapshot
} from "./persistence";

describe("conversation shell persistence", () => {
  it("preserves explicit OpenAI dictation selection and defaults old snapshots to browser speech", () => {
    const snapshot = shellStateToRuntimeSnapshot({ ...defaultShellState, voiceProvider: "openai" });
    expect(shellStateFromRuntimeSnapshot(snapshot, defaultShellState).voiceProvider).toBe("openai");
    delete snapshot.voiceProvider;
    expect(shellStateFromRuntimeSnapshot(snapshot, defaultShellState).voiceProvider).toBe("browser");
  });
  beforeEach(() => window.localStorage.clear());

  it.each(["robot-v3", "rounded-v2", "organic-v1"])("preserves every selected %s portrait across persistence", (version) => {
    for (let variant = 0; variant < 8; variant++) {
      const avatarSeed = `${version}:${variant}:saved-agent`;
      const profile = { ...defaultShellState.agents![0], avatarSeed };
      const restored = shellStateFromRuntimeSnapshot(shellStateToRuntimeSnapshot({ ...defaultShellState, agents: [profile] }), defaultShellState);
      expect(restored.agents![0].avatarSeed).toBe(avatarSeed);
      expect(avatarVariant(restored.agents![0].avatarSeed!)).toBe(variant);
    }
  });

  it("preserves newly generated portraits through local storage", () => {
    const avatarSeed = createAvatarSeed();
    persistShellState({ ...defaultShellState, agents: [{ ...defaultShellState.agents![0], avatarSeed }] });
    expect(readPersistedShellState(defaultShellState).agents![0].avatarSeed).toBe(avatarSeed);
  });

  it.each(["robot-v3:8:invalid", "robot-v3:missing", "unknown:3:invalid", `robot-v3:2:${"a".repeat(160)}`])("replaces invalid saved avatar seed %s", (avatarSeed) => {
    const profile = { ...defaultShellState.agents![0], avatarSeed };
    const restored = shellStateFromRuntimeSnapshot(shellStateToRuntimeSnapshot({ ...defaultShellState, agents: [profile] }), defaultShellState);
    expect(restored.agents![0].avatarSeed).toBe(`blob-v1:${profile.id}`);
  });

  it("keeps agent skills, reasoning and previous conversations across snapshots", () => {
    const profile = { ...defaultShellState.agents![0], avatarSeed: "blob-v1:stable-avatar", reasoningEffort: "high", threadId: "current", threadIds: ["earlier", "earlier"], learnedTasks: [{ id: "weekly", title: "Plan", instruction: "Ask about priorities", createdAt: "2026-09-04", updatedAt: "2026-09-04" }] };
    const restored = shellStateFromRuntimeSnapshot(shellStateToRuntimeSnapshot({ ...defaultShellState, agents: [profile] }), defaultShellState);
    expect(restored.agents![0]).toMatchObject({ avatarSeed: profile.avatarSeed, reasoningEffort: "high", threadIds: ["earlier", "current"], learnedTasks: profile.learnedTasks });
  });

  it("round-trips the supported local state without orchestration collections", () => {
    const snapshot = shellStateToRuntimeSnapshot({
      ...defaultShellState,
      hiddenModelIds: ["codex::hidden-model"],
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

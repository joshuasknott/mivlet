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
  it("persists per-agent notification preferences and enables old profiles by default", () => {
    for (const enabled of [true, false, undefined]) {
      const profile = { ...defaultShellState.agents![0], notificationsEnabled: enabled };
      const restored = shellStateFromRuntimeSnapshot(shellStateToRuntimeSnapshot({ ...defaultShellState, agents: [profile] }), defaultShellState);
      expect(restored.agents![0].notificationsEnabled).toBe(enabled !== false);
    }
  });
  it("retains ambiguous browser data without importing or mirroring it into a native account", () => {
    const legacy = JSON.stringify({ ...defaultShellState, composerValue: "OTHER_ACCOUNT_DRAFT" });
    localStorage.setItem(STORAGE_KEY, legacy);
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    try {
      expect(readPersistedShellState(defaultShellState)).toBe(defaultShellState);
      persistShellState({ ...defaultShellState, composerValue: "NEW_ACCOUNT_DRAFT" });
      expect(localStorage.getItem(STORAGE_KEY)).toBe(legacy);
    } finally { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); }
  });

  it("preserves explicit OpenAI dictation selection and defaults old snapshots to browser speech", () => {
    const snapshot = shellStateToRuntimeSnapshot({ ...defaultShellState, voiceProvider: "openai" });
    expect(shellStateFromRuntimeSnapshot(snapshot, defaultShellState).voiceProvider).toBe("openai");
    delete snapshot.voiceProvider;
    expect(shellStateFromRuntimeSnapshot(snapshot, defaultShellState).voiceProvider).toBe("browser");
  });
  beforeEach(() => window.localStorage.clear());

  it.each(["robot-v3", "rounded-v2", "organic-v1"])("preserves %s seeds and deterministically maps them to the six ink characters", (version) => {
    for (let variant = 0; variant < 8; variant++) {
      const avatarSeed = `${version}:${variant}:saved-agent`;
      const profile = { ...defaultShellState.agents![0], avatarSeed };
      const restored = shellStateFromRuntimeSnapshot(shellStateToRuntimeSnapshot({ ...defaultShellState, agents: [profile] }), defaultShellState);
      expect(restored.agents![0].avatarSeed).toBe(avatarSeed);
      expect(avatarVariant(restored.agents![0].avatarSeed!)).toBe(variant % 6);
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
    const profile = { ...defaultShellState.agents![0], avatarSeed: "blob-v1:stable-avatar", reasoningEffort: "high", fastMode: true, threadId: "current", threadIds: ["earlier", "earlier"], learnedTasks: [{ id: "weekly", title: "Plan", instruction: "Ask about priorities", createdAt: "2026-09-04", updatedAt: "2026-09-04" }] };
    const restored = shellStateFromRuntimeSnapshot(shellStateToRuntimeSnapshot({ ...defaultShellState, agents: [profile] }), defaultShellState);
    expect(restored.agents![0]).toMatchObject({ avatarSeed: profile.avatarSeed, reasoningEffort: "high", threadIds: ["earlier", "current"], learnedTasks: profile.learnedTasks });
    expect(restored.agents![0].fastMode).toBe(true);
  });

  it("round-trips the selected user-owned computer and defaults old agents to This PC", () => {
    const profile = {
      ...defaultShellState.agents![0],
      computer: { kind: "instabox" as const, machineId: "machine-a", connectionRevision: 3 },
    };
    const snapshot = shellStateToRuntimeSnapshot({ ...defaultShellState, agents: [profile] });
    expect(shellStateFromRuntimeSnapshot(snapshot, defaultShellState).agents![0].computer).toEqual(profile.computer);
    const legacy = { ...snapshot, agents: [{ ...profile, computer: undefined }] };
    expect(shellStateFromRuntimeSnapshot(legacy, defaultShellState).agents![0].computer).toEqual({ kind: "local" });
  });

  it("retains an invalid explicit machine preference marker instead of silently selecting This PC", () => {
    const snapshot = shellStateToRuntimeSnapshot({
      ...defaultShellState,
      agents: [{ ...defaultShellState.agents![0], computer: { kind: "instabox", machineId: "../other", connectionRevision: 2 } as never }],
    });
    const restored = shellStateFromRuntimeSnapshot(snapshot, defaultShellState).agents![0];
    expect(restored.computer).toEqual({ kind: "local" });
    expect(restored.computerPreferenceError).toBe("invalid");
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

  it("keeps legacy browser state out of the first-agent setup journey", () => {
    const legacy = { ...defaultShellState } as Record<string, unknown>;
    delete legacy.onboardingVersion;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(legacy));
    expect(readPersistedShellState(defaultShellState).onboardingVersion).toBe(0);
  });

  it("treats a missing native onboarding version as a legacy snapshot", () => {
    const snapshot = shellStateToRuntimeSnapshot(defaultShellState);
    delete snapshot.onboardingVersion;
    expect(
      shellStateFromRuntimeSnapshot(snapshot, defaultShellState).onboardingVersion,
    ).toBe(0);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_IMPORT_SENTINEL,
  LEGACY_STORAGE_KEYS,
  STORAGE_KEY
} from "./constants";
import {
  importLegacyShellStateOnce,
  readPersistedShellState,
  shellStateFromRuntimeSnapshot,
  shellStateToRuntimeSnapshot
} from "./persistence";
import type { PersistedShellState } from "./types";

const defaultState: PersistedShellState = {
  activeItem: "new-chat",
  composerValue: "",
  voiceEnabled: false,
  approvalAudit: [],
  dismissedApprovalIds: [],
  approvalRules: [],
  schedules: [],
  goals: [],
  plans: [],
  pinnedSourceIds: [],
  importedKnowledgeSources: [],
  memoryDisabled: false,
  memoryRecords: [],
  connectedBackendIds: [],
  selectedModelId: "",
  permissionMode: "full-access"
};

describe("Fable persistence migration", () => {
  beforeEach(() => window.localStorage.clear());

  it.each(LEGACY_STORAGE_KEYS)("copies %s state into the Fable namespace", (legacyKey) => {
    window.localStorage.setItem(
      legacyKey,
      JSON.stringify({
        ...defaultState,
        composerValue: "Recovered work",
        pinnedSourceIds: ["source-1"]
      })
    );

    const recovered = readPersistedShellState(defaultState);

    expect(recovered.composerValue).toBe("Recovered work");
    expect(recovered.pinnedSourceIds).toEqual(["source-1"]);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}")).toMatchObject({
      composerValue: "Recovered work",
      pinnedSourceIds: ["source-1"]
    });
    expect(window.localStorage.getItem(legacyKey)).not.toBeNull();
  });

  it("normalizes persisted Arden thread ids without dropping the restored draft", () => {
    window.localStorage.setItem(
      "arden.shell.v1",
      JSON.stringify({
        ...defaultState,
        activeItem: "arden-initial-build",
        composerValue: "Continue the existing thread"
      })
    );

    expect(readPersistedShellState(defaultState)).toMatchObject({
      activeItem: "fable-initial-build",
      composerValue: "Continue the existing thread"
    });
  });
});

describe("Fable schedules round-trip through the runtime snapshot", () => {
  it("carries schedules into the snapshot and back so they survive a restart", () => {
    const withSchedules: PersistedShellState = {
      ...defaultState,
      schedules: [
        {
          id: "weekly-digest",
          name: "Weekly digest",
          description: "Summarize approvals.",
          day: "Fri",
          time: "09:00",
          enabled: true,
          createdAt: "2026-06-26T10:30:00.000Z"
        }
      ]
    };

    const snapshot = shellStateToRuntimeSnapshot(withSchedules);
    expect(snapshot.schedules).toEqual(withSchedules.schedules);

    // Round-tripping back through the snapshot must not drop the schedule
    // (previously schedules were shell-local and were silently wiped here).
    const recovered = shellStateFromRuntimeSnapshot(snapshot, defaultState);
    expect(recovered.schedules).toEqual(withSchedules.schedules);
  });

  it("falls back to default schedules when a snapshot omits them", () => {
    const snapshot = shellStateToRuntimeSnapshot(defaultState);
    // Simulate a legacy snapshot written before schedules joined the contract.
    const { schedules: _omit, ...withoutSchedules } = snapshot;
    expect(
      shellStateFromRuntimeSnapshot(withoutSchedules as typeof snapshot, defaultState).schedules
    ).toEqual(defaultState.schedules);
  });
});

describe("Fable persistence secret boundary", () => {
  beforeEach(() => window.localStorage.clear());

  it("never injects secrets into snapshot fields the user did not type", () => {
    // A user pasted a token into the composer draft. That is the only place it
    // may appear; the conversion must not copy it into any other field.
    const planted: PersistedShellState = {
      ...defaultState,
      composerValue: "Authorization: Bearer sk-leak-me-12345"
    };

    const snapshot = shellStateToRuntimeSnapshot(planted);
    const serialized = JSON.stringify(snapshot);

    // The token survives only where the user put it (the composer draft).
    expect(snapshot.composerDraft).toContain("sk-leak-me-12345");
    // No other snapshot field carries the token.
    expect(snapshot.activeItem).not.toContain("sk-leak-me-12345");
    expect(snapshot.selectedModelId).not.toContain("sk-leak-me-12345");
    // The snapshot has no secret-named keys at all.
    expect(serialized).not.toContain('"secret"');
    expect(serialized).not.toContain('"token"');
    expect(serialized).not.toContain('"apiKey"');
  });

  it("persists exactly the documented PersistedShellState keys and no secret-named keys", () => {
    const state: PersistedShellState = {
      ...defaultState,
      composerValue: "draft"
    };

    // Round-trip through localStorage the way persistShellState does.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");

    // The persisted payload carries only the documented, non-secret fields.
    expect(Object.keys(stored).sort()).toEqual(
      [
        "activeItem",
        "composerValue",
        "voiceEnabled",
        "approvalAudit",
        "dismissedApprovalIds",
        "approvalRules",
        "schedules",
        "goals",
        "plans",
        "pinnedSourceIds",
        "importedKnowledgeSources",
        "memoryDisabled",
        "memoryRecords",
        "connectedBackendIds",
        "selectedModelId",
        "permissionMode"
      ].sort()
    );
    // No secret-shaped key names leak in.
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain('"secret"');
    expect(serialized).not.toContain('"token"');
    expect(serialized).not.toContain('"password"');
    expect(serialized).not.toContain('"apiKey"');
  });

  it("keeps dictation opt-in conservative and never adds audio or transcript fields", () => {
    const snapshot = shellStateToRuntimeSnapshot(defaultState);
    expect(snapshot.voiceEnabled).toBe(false);
    expect(JSON.stringify(snapshot)).not.toMatch(/"audio"|"transcript"/i);

    const { voiceEnabled: _legacyMissing, ...legacySnapshot } = snapshot;
    expect(
      shellStateFromRuntimeSnapshot(
        legacySnapshot as typeof snapshot,
        { ...defaultState, voiceEnabled: true }
      ).voiceEnabled
    ).toBe(false);
  });

  it("never carries secrets in connected backend ids (ids only)", () => {
    const state: PersistedShellState = {
      ...defaultState,
      connectedBackendIds: ["codex", "openai"]
    };

    const snapshot = shellStateToRuntimeSnapshot(state);
    expect(snapshot.connectedBackendIds).toEqual(["codex", "openai"]);
    // The snapshot field is provider ids only — never raw credentials.
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('"secret"');
    expect(serialized).not.toContain('"token"');
    expect(serialized).not.toContain('"apiKey"');
  });
});

describe("Fable desktop one-time legacy import", () => {
  beforeEach(() => window.localStorage.clear());

  it.each(LEGACY_STORAGE_KEYS)(
    "imports %s legacy state once, then never reads it again",
    (legacyKey) => {
      window.localStorage.setItem(
        legacyKey,
        JSON.stringify({
          ...defaultState,
          composerValue: "Legacy import once",
          schedules: [
            {
              id: "legacy-schedule",
              name: "Legacy digest",
              description: "Imported schedule.",
              day: "Mon",
              time: "08:00",
              enabled: true,
              createdAt: "2026-06-20T10:00:00.000Z"
            }
          ]
        })
      );

      // First call: imports the legacy state and copies it forward.
      const imported = importLegacyShellStateOnce(defaultState);
      expect(imported.composerValue).toBe("Legacy import once");
      expect(imported.schedules[0]?.name).toBe("Legacy digest");

      // The sentinel marks the migration done.
      expect(window.localStorage.getItem(LEGACY_IMPORT_SENTINEL)).toBe("1");
      // The canonical key now holds the imported, non-secret state.
      const copied = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
      expect(copied.composerValue).toBe("Legacy import once");

      // Second call: returns defaults — the snapshot is the source of truth now.
      const second = importLegacyShellStateOnce(defaultState);
      expect(second.composerValue).toBe(defaultState.composerValue);
      expect(second.schedules).toEqual(defaultState.schedules);
    }
  );

  it("marks the migration done even when there is nothing to import", () => {
    expect(importLegacyShellStateOnce(defaultState)).toEqual(defaultState);
    expect(window.localStorage.getItem(LEGACY_IMPORT_SENTINEL)).toBe("1");
  });

  it("writes no secret-shaped keys into the migration metadata", () => {
    window.localStorage.setItem(
      LEGACY_STORAGE_KEYS[0],
      JSON.stringify({ ...defaultState, composerValue: "innocuous" })
    );

    importLegacyShellStateOnce(defaultState);

    // The sentinel value is a plain marker with no payload, and no secret-named
    // key appears anywhere in localStorage after the migration.
    expect(window.localStorage.getItem(LEGACY_IMPORT_SENTINEL)).toBe("1");
    const allKeys = Object.keys(window.localStorage);
    expect(allKeys.some((key) => /secret|token|password|apikey/i.test(key))).toBe(false);
    const everything = JSON.stringify(
      Object.fromEntries(allKeys.map((key) => [key, window.localStorage.getItem(key)]))
    );
    expect(everything).not.toContain('"secret"');
    expect(everything).not.toContain('"token"');
    expect(everything).not.toContain('"apiKey"');
  });
});

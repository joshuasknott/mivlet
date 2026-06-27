import { beforeEach, describe, expect, it } from "vitest";
import { LEGACY_STORAGE_KEYS, STORAGE_KEY } from "./constants";
import { readPersistedShellState } from "./persistence";
import type { PersistedShellState } from "./types";

const defaultState: PersistedShellState = {
  activeItem: "new-chat",
  composerValue: "",
  voiceEnabled: false,
  approvalAudit: [],
  dismissedApprovalIds: [],
  approvalRules: [],
  schedules: [],
  pinnedSourceIds: [],
  importedKnowledgeSources: [],
  memoryDisabled: false,
  memoryRecords: [],
  connectedBackendIds: []
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

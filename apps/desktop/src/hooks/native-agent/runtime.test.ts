import { afterEach, describe, expect, it } from "vitest";
import {
  clearNativeAgentPresentation,
  createInitialNativeAgentState,
  hasDesktopRuntime,
} from "./runtime";

describe("native agent runtime", () => {
  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__;
  });

  it("treats a missing Tauri runtime as no-transport", () => {
    expect(hasDesktopRuntime()).toBe(false);
    expect(createInitialNativeAgentState().noTransport).toBe(true);
  });

  it("detects the desktop runtime when Tauri internals are present", () => {
    (
      window as Window & { __TAURI_INTERNALS__?: unknown }
    ).__TAURI_INTERNALS__ = {};
    expect(hasDesktopRuntime()).toBe(true);
    expect(createInitialNativeAgentState().noTransport).toBe(false);
  });

  it("clears visible progress without dropping recovered receipts", () => {
    const current = {
      ...createInitialNativeAgentState(),
      transcript: "Hello",
      running: true,
      currentAttemptId: "run-1",
      contextReceipts: { "run-1": { version: 1 } as never },
      recoverableAttempts: [{ id: "run-0" } as never],
    };
    const cleared = clearNativeAgentPresentation(current);
    expect(cleared.transcript).toBe("");
    expect(cleared.running).toBe(false);
    expect(cleared.currentAttemptId).toBeNull();
    expect(cleared.contextReceipts).toEqual(current.contextReceipts);
    expect(cleared.recoverableAttempts).toEqual(current.recoverableAttempts);
  });
});

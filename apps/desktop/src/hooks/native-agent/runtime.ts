import type { NativeAgentState } from "./types";

/** True when the desktop (Tauri) runtime is present (drives the noTransport state). */
export function hasDesktopRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(
      (window as Window & { __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__,
    )
  );
}

export function createInitialNativeAgentState(): NativeAgentState {
  return {
    transcript: "",
    reasoningSummaries: {},
    activity: "",
    usage: null,
    running: false,
    stopRequested: false,
    lastError: null,
    status: "idle",
    recoverableAttempts: [],
    contextReceipts: {},
    providerRoutes: {},
    usageReceipts: {},
    currentAttemptId: null,
    progressAgentId: undefined,
    noTransport: !hasDesktopRuntime(),
  };
}

/** Navigation is a hard presentation boundary for in-flight progress fields. */
export function clearNativeAgentPresentation(
  current: NativeAgentState,
): NativeAgentState {
  return {
    ...current,
    transcript: "",
    responseParts: [],
    progressPrompt: undefined,
    startedAt: undefined,
    endedAt: undefined,
    progressThreadId: undefined,
    progressAgentId: undefined,
    stopRequested: false,
    reasoningSummaries: {},
    activity: "",
    usage: null,
    running: false,
    lastError: null,
    contextFailure: undefined,
    status: "idle",
    currentAttemptId: null,
  };
}

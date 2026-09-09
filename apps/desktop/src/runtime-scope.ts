/**
 * The selected Mivlet workspace is the only implicit scope allowed at the
 * renderer/native boundary. Native callers must set it from the verified
 * account-workspace directory before any workspace-owned command is invoked.
 */
export type RuntimeDataScope = Record<string, unknown> & {
  workspaceId: string;
};

export const PREVIEW_RUNTIME_DATA_SCOPE: RuntimeDataScope = {
  workspaceId: "preview-default"
};

let activeScope: RuntimeDataScope | null = null;

function isNativeRuntime() {
  return (
    typeof window !== "undefined" &&
    Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  );
}

/** Explicit fixture scope only. Production never falls back to this value. */
export function getActiveRuntimeDataScope(): RuntimeDataScope | null {
  if (activeScope) return activeScope;
  return isNativeRuntime() ? null : PREVIEW_RUNTIME_DATA_SCOPE;
}

export function setActiveRuntimeDataScope(workspaceId: string): RuntimeDataScope {
  activeScope = { workspaceId };
  return activeScope;
}

export function clearActiveRuntimeDataScope() {
  activeScope = null;
}

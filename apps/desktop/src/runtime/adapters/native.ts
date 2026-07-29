import type { RuntimeAdapter, RuntimeEvent } from "../ports";

let coreModule: Promise<typeof import("@tauri-apps/api/core")> | undefined;
let eventModule: Promise<typeof import("@tauri-apps/api/event")> | undefined;

function loadCore() {
  coreModule ??= import("@tauri-apps/api/core");
  return coreModule;
}

function loadEvents() {
  eventModule ??= import("@tauri-apps/api/event");
  return eventModule;
}

/**
 * Tauri is loaded only after a native command or event is actually requested,
 * keeping its bridge out of the development preview path.
 */
export const nativeRuntimeAdapter: RuntimeAdapter = {
  kind: "native",
  async invoke<T>(command: string, args?: Record<string, unknown>) {
    const { invoke } = await loadCore();
    return args === undefined ? invoke<T>(command) : invoke<T>(command, args);
  },
  async listen<T>(
    eventName: string,
    handler: (event: RuntimeEvent<T>) => void,
  ) {
    const { listen } = await loadEvents();
    return listen<T>(eventName, handler);
  },
};

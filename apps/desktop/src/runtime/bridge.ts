import { getActiveRuntimeDataScope } from "../runtime-scope";
import { getRuntimeAdapter, hasNativeRuntimeAdapter } from "./adapters/select";
import { toRuntimeError } from "./errors";
import type { RuntimeEvent, RuntimeUnlisten } from "./ports";

export const hasTauriRuntime = hasNativeRuntimeAdapter;
export const activeDataScope = getActiveRuntimeDataScope;

export function invoke<T>(command: string, args?: Record<string, unknown>) {
  return getRuntimeAdapter().invoke<T>(command, args);
}

/** Native-only operations share the same preview and error boundary. */
export async function invokeNative<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  if (!hasNativeRuntimeAdapter()) return null;
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export function listen<T>(
  event: string,
  handler: (event: RuntimeEvent<T>) => void,
): Promise<RuntimeUnlisten> {
  return getRuntimeAdapter().listen<T>(event, handler);
}

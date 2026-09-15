export type RuntimeAdapterKind = "native" | "preview";

export interface RuntimeEvent<T> {
  event: string;
  id: number;
  payload: T;
}

export type RuntimeUnlisten = () => void;

interface RuntimeCommandPort {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

interface RuntimeEventPort {
  listen<T>(
    event: string,
    handler: (event: RuntimeEvent<T>) => void,
  ): Promise<RuntimeUnlisten>;
}

/**
 * Domain modules depend on this adapter contract, not directly on Tauri.
 */
export interface RuntimeAdapter extends RuntimeCommandPort, RuntimeEventPort {
  readonly kind: RuntimeAdapterKind;
}

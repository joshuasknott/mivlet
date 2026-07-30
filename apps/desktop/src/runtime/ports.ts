export type RuntimeAdapterKind = "native" | "preview";

export interface RuntimeEvent<T> {
  event: string;
  id: number;
  payload: T;
}

export type RuntimeUnlisten = () => void;

export interface RuntimeCommandPort {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export interface RuntimeEventPort {
  listen<T>(
    event: string,
    handler: (event: RuntimeEvent<T>) => void,
  ): Promise<RuntimeUnlisten>;
}

/**
 * The domain-neutral boundary used by the stable runtime façade. Domain ports
 * depend on this contract, not directly on Tauri.
 */
export interface RuntimeAdapter extends RuntimeCommandPort, RuntimeEventPort {
  readonly kind: RuntimeAdapterKind;
}

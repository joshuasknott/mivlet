import type { DesktopToolExecutorOptions } from "./desktop-tool-options";
const CANCELLED = "This connected app task was cancelled or its access changed.";

/** Each task owns its connection. Stop closes it without waiting for a server response. */
export async function runConnectedApp<T extends { client: { close(): Promise<void> } }, R>(
  options: DesktopToolExecutorOptions,
  accessCurrent: () => boolean,
  open: () => Promise<T>,
  execute: (connection: T, requireCurrent: () => void) => Promise<R>,
): Promise<R> {
  const admitted = options.localComputerCurrent?.() ?? options.localComputer;
  const generation = admitted ? { ...admitted } : undefined;
  const current = () => {
    if (options.shouldCancel?.() || !accessCurrent()) return false;
    if (!generation) return true;
    const now = options.localComputerCurrent?.() ?? options.localComputer;
    return now?.workspaceId === generation.workspaceId && now.agentId === generation.agentId
      && now.generation === generation.generation && now.controller !== "human" && now.controller !== "paused";
  };
  let connection: T | undefined;
  let closePromise: Promise<void> | undefined;
  const close = () => connection
    ? closePromise ??= connection.client.close().catch(() => undefined) : Promise.resolve();
  let cancelled = false;
  const requireCurrent = () => { if (cancelled || !current()) { cancelled = true; void close(); throw new Error(CANCELLED); } };
  let timer: ReturnType<typeof setInterval> | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    const check = () => {
      if (current()) return;
      cancelled = true;
      void close();
      reject(new Error(CANCELLED + " External effects already accepted may have completed."));
    };
    check();
    timer = setInterval(check, 50);
  });
  const task = (async () => {
    requireCurrent();
    connection = await open();
    requireCurrent();
    const result = await execute(connection, requireCurrent);
    requireCurrent();
    return result;
  })();
  try {
    return await Promise.race([task, cancellation]);
  } finally {
    clearInterval(timer);
    if (cancelled) void close();
    else await close();
  }
}

/** Bound read-only IPC waits. Mutating requests must be cancelled at their
 * native owner instead; abandoning a promise does not cancel native work. */
export function readWithDeadline<T>(
  request: Promise<T>,
  message: string,
  timeoutMs = 60_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(message)),
      timeoutMs,
    );
    request.then(resolve, reject).finally(() => window.clearTimeout(timer));
  });
}

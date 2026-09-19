import { afterEach, expect, it, vi } from "vitest";
import { readWithDeadline } from "./read-deadline";
afterEach(() => vi.useRealTimers());
it("fails a stalled read and ignores its late completion", async () => {
  vi.useFakeTimers();
  let resolve!: (value: string) => void;
  const pending = new Promise<string>((done) => {
    resolve = done;
  });
  const result = readWithDeadline(pending, "Timed out", 1000);
  const rejected = expect(result).rejects.toThrow("Timed out");
  await vi.advanceTimersByTimeAsync(1000);
  await rejected;
  resolve("late");
  await expect(result).rejects.toThrow("Timed out");
});

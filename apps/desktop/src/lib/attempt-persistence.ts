import type { ExecutionAttempt } from "@fable/protocol";
import type {
  DurableRunRecord,
  DurableRunWriter,
} from "./conversation-runtime";

/** One attempt's accepted state and ordered writes, independent of disk cadence. */
export function createAttemptPersistence(
  saveAttempt: (attempt: ExecutionAttempt) => Promise<unknown>,
) {
  let current: ExecutionAttempt | null = null;
  let stopped = false;
  let chain = Promise.resolve();
  let stopPromise: Promise<void> | null = null;
  let writer: DurableRunWriter | null = null;
  const enqueue = (work: () => Promise<unknown>) => {
    const result = chain.then(work).then(() => undefined);
    chain = result.catch(() => undefined);
    return result;
  };
  return {
    get current() {
      return current;
    },
    set current(value: ExecutionAttempt | null) {
      if (!stopped) current = value;
    },
    get stopped() {
      return stopped;
    },
    setWriter(value: DurableRunWriter | null) {
      writer = value;
    },
    save(snapshot: ExecutionAttempt) {
      return stopped ? Promise.resolve() : enqueue(() => saveAttempt(snapshot));
    },
    record(record: DurableRunRecord) {
      return stopped
        ? Promise.resolve()
        : enqueue(async () => writer?.record(record));
    },
    checkpointAssistant(content: string, terminal = false) {
      return stopped
        ? Promise.resolve()
        : enqueue(async () => writer?.checkpointAssistant(content, terminal));
    },
    stop() {
      if (stopPromise) return stopPromise;
      // Freeze before any await or provider cancellation callback can deliver
      // another event. Already accepted writes drain before this final flush.
      stopped = true;
      if (!current) return Promise.resolve();
      const terminal: ExecutionAttempt = {
        ...current,
        status: "cancelled",
        recoverable: false,
        pendingApprovalIds: [],
        updatedAt: new Date().toISOString(),
      };
      current = terminal;
      stopPromise = enqueue(async () => {
        // Attempt both stores even if one fails. Never imply that a journal
        // checkpoint alone proves the canonical conversation survived.
        const outcomes = await Promise.allSettled([
          writer?.checkpointAssistant(terminal.transcript, true),
          saveAttempt(terminal),
        ]);
        // The interruption is ordered after the final assistant checkpoint.
        // DurableRunWriter recovers its queue after a failed write, so attempt
        // the marker even when the checkpoint itself could not be stored.
        const interruption = await Promise.allSettled([
          writer?.record({
            kind: "interruption",
            content: "The response was stopped.",
            reason: "user-stop",
          }),
        ]);
        const failure = [...outcomes, ...interruption].find(
          (outcome) => outcome.status === "rejected",
        );
        if (failure?.status === "rejected") throw failure.reason;
      });
      return stopPromise;
    },
  };
}

export type AttemptPersistence = ReturnType<typeof createAttemptPersistence>;

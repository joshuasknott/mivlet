import type { Dispatch, SetStateAction } from "react";
import type { AgentBackend } from "@mivlet/connectors";
import type { AttemptPersistence } from "../../lib/attempt-persistence";
import type { NativeAgentState } from "./types";

export async function cancelNativeAgentRun(input: {
  backendToCancel: AgentBackend | null;
  attemptToCancel: string | null;
  persistence: AttemptPersistence | null;
  setState: Dispatch<SetStateAction<NativeAgentState>>;
  onCancel?: () => void;
  clearActive: (persistence: AttemptPersistence | null) => void;
}): Promise<void> {
  const {
    backendToCancel,
    attemptToCancel,
    persistence,
    setState,
    onCancel,
    clearActive,
  } = input;
  // Freeze the generation before any await. Approval authority is revoked at
  // the same boundary, while disk and provider acknowledgement finish below.
  const finalFlush = persistence?.stop();
  if (attemptToCancel) {
    setState((current) =>
      current.currentAttemptId === attemptToCancel
        ? { ...current, stopRequested: true }
        : current,
    );
  }
  // Reject approval waiters immediately, even when native cancellation is
  // slow or unavailable. No lost card may leave a provider waiting forever.
  onCancel?.();
  const nativeCancellation = Promise.resolve()
    .then(() => backendToCancel?.cancel(attemptToCancel ?? ""))
    .catch(() => {
      setState((current) =>
        current.currentAttemptId === attemptToCancel
          ? {
              ...current,
              lastError:
                "The response stopped locally, but provider cancellation could not be confirmed.",
            }
          : current,
      );
    });
  let persistenceError: string | null = null;
  try {
    await finalFlush;
  } catch {
    persistenceError =
      "The response stopped, but its latest output could not be saved. Keep this conversation open and copy the response before reloading or continuing.";
  }
  setState((current) =>
    current.currentAttemptId === attemptToCancel
      ? {
          ...current,
          running: false,
          status: "cancelled",
          endedAt:
            persistence?.current?.updatedAt ?? new Date().toISOString(),
          lastError: persistenceError ?? current.lastError,
        }
      : current,
  );
  clearActive(persistence);
  await nativeCancellation;
}

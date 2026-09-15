/** Compare-and-set helpers for hosted computer/browser generation fences. */

export type HostedProcessReplayKind = "miss" | "hit" | "stale";

/** requestKey idempotency is per generation. A previous computer lifetime is not a replay hit. */
export function hostedProcessReplayKind(
  replayGeneration: number | undefined,
  expectedGeneration: number
): HostedProcessReplayKind {
  if (replayGeneration === undefined) return "miss";
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) return "stale";
  if (!Number.isSafeInteger(replayGeneration) || replayGeneration !== expectedGeneration) {
    return "stale";
  }
  return "hit";
}

export function browserSessionAfterFence(
  state: { computerId: string; generation: number; sessionId: string | null } | null,
  computerId: string,
  generation: number
): { destroyPrevious: boolean; resumeSessionId: string | null } {
  if (!state) return { destroyPrevious: false, resumeSessionId: null };
  if (state.computerId !== computerId || state.generation !== generation) {
    return { destroyPrevious: true, resumeSessionId: null };
  }
  return { destroyPrevious: false, resumeSessionId: state.sessionId };
}

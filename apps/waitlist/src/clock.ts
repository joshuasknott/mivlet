export interface Clock {
  nowMs(): number;
}

export const realClock: Clock = { nowMs: () => Date.now() };

export function fixedClock(now: number): Clock {
  return { nowMs: () => now };
}

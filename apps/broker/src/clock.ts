/**
 * Injectable clock so store TTL and expiry math are deterministic in tests.
 */

export interface BrokerClock {
  nowMs(): number;
}

/** Fixed clock for tests. */
export function fixedClock(ms: number): BrokerClock {
  let current = ms;
  return {
    nowMs: () => current,
    advance(by: number) {
      current += by;
    }
  } as BrokerClock;
}

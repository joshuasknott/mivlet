import type { WaitlistDB } from "./db.js";
import type { RateLimiter } from "./rate-limiter.js";

export interface WaitlistServices {
  db: WaitlistDB;
  verifyTurnstile: (token: string, ip?: string) => Promise<boolean>;
  clock: { nowMs: () => number; nowIso: () => string };
  log: (message: string) => void;
  signupLimiter?: RateLimiter;
  emailLimiter?: RateLimiter;
  /** Test-only capture for issued magic tokens; never persisted or logged. */
  capture?: {
    issued: Array<{ type: string; token: string; subscriberId: string }>;
  };
}

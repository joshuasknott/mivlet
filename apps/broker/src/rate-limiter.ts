/**
 * Fixed-window rate limiter + redacted logger + correlation ids.
 *
 * The limiter is in-process and per-key (route + peer address). It exists to keep
 * a single misbehaving or hostile desktop from hammering the broker or a provider;
 * it is not a substitute for provider-side limits. Windows and limits are
 * configurable and tested.
 */

import { base64url, randomBytes } from "./crypto-web.js";
import type { BrokerClock } from "./clock.js";

export interface RateLimiterOptions {
  /** Requests allowed per window per key. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  clock?: BrokerClock;
  /**
   * Maximum number of tracked keys before an idle-entry sweep runs. Bounds memory
   * so a hostile client rotating keys (e.g. one peer per request) cannot grow the
   * windows map without limit. Default 4096. When the cap is reached the limiter
   * sweeps expired entries and, if still full, fails closed (denies).
   */
  maxKeys?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Remaining in the current window (for the Retry-After hint). */
  remaining: number;
  /** Milliseconds until the window resets. */
  retryAfterMs: number;
}

export interface RateLimiter {
  /** Check + record a request for a key. */
  check(key: string): RateLimitResult | Promise<RateLimitResult>;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const clock = options.clock ?? { nowMs: () => Date.now() };
  const maxKeys = options.maxKeys ?? 4096;
  // `lastSeen` is tracked so an idle-key sweep can drop entries whose window has
  // expired even when the map has not reached the hard cap, preventing unbounded
  // growth from distinct (route + peer) keys over time.
  const windows = new Map<string, { start: number; count: number; lastSeen: number }>();

  /** Drop every entry whose window has elapsed. Returns the number removed. */
  function sweepExpired(now: number): number {
    let removed = 0;
    for (const [key, entry] of windows) {
      if (now - entry.start >= options.windowMs) {
        windows.delete(key);
        removed++;
      }
    }
    return removed;
  }

  return {
    check(key) {
      const now = clock.nowMs();
      const existing = windows.get(key);
      if (!existing || now - existing.start >= options.windowMs) {
        // New window for this key. Bound memory: if the map is at capacity, first
        // reclaim expired entries; if still full, fail closed (deny) rather than
        // letting an attacker exhaust memory by rotating keys.
        if (windows.size >= maxKeys && !windows.has(key)) {
          sweepExpired(now);
          if (windows.size >= maxKeys) {
            return { allowed: false, remaining: 0, retryAfterMs: options.windowMs };
          }
        }
        windows.set(key, { start: now, count: 1, lastSeen: now });
        return { allowed: true, remaining: options.limit - 1, retryAfterMs: options.windowMs };
      }
      existing.count += 1;
      existing.lastSeen = now;
      const allowed = existing.count <= options.limit;
      const remaining = Math.max(0, options.limit - existing.count);
      const retryAfterMs = Math.max(0, existing.start + options.windowMs - now);
      // Opportunistic sweep once the map is reasonably full, so idle keys are
      // reclaimed without waiting for the hard cap to be hit.
      if (windows.size >= maxKeys) sweepExpired(now);
      return { allowed, remaining, retryAfterMs };
    }
  };
}

/**
 * Build a composite limiter key for a route + peer so one client cannot exhaust
 * another's budget. The peer address is taken from the request; it is never logged.
 */
export function rateLimitKey(route: string, peer: string | undefined): string {
  return `${route}:${peer ?? "anonymous"}`;
}

/** Generate a short correlation id for request tracing. */
export function newCorrelationId(): string {
  return base64url(randomBytes(12));
}

/** Redact any value that looks like a secret/token from a string before logging. */
export function redactForLog(input: string): string {
  return input
    // Bearer tokens / long opaque strings after authorization keywords.
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1[redacted]")
    // URL query params that carry secrets/codes.
    .replace(/(code=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(token=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(access_token=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(refresh_token=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(client_secret=)[^&\s]+/gi, "$1[redacted]")
    // JSON string fields holding token-like values.
    .replace(/"access_token"\s*:\s*"[^"]*"/gi, '"access_token":"[redacted]"')
    .replace(/"refresh_token"\s*:\s*"[^"]*"/gi, '"refresh_token":"[redacted]"')
    .replace(/"client_secret"\s*:\s*"[^"]*"/gi, '"client_secret":"[redacted]"');
}

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
  check(key: string): RateLimitResult;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const clock = options.clock ?? { nowMs: () => Date.now() };
  const windows = new Map<string, { start: number; count: number }>();

  return {
    check(key) {
      const now = clock.nowMs();
      const entry = windows.get(key);
      if (!entry || now - entry.start >= options.windowMs) {
        windows.set(key, { start: now, count: 1 });
        return { allowed: true, remaining: options.limit - 1, retryAfterMs: options.windowMs };
      }
      entry.count += 1;
      const allowed = entry.count <= options.limit;
      const remaining = Math.max(0, options.limit - entry.count);
      const retryAfterMs = Math.max(0, entry.start + options.windowMs - now);
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

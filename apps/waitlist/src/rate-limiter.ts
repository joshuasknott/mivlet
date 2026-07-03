/**
 * Fixed-window rate limiter for waitlist (signup per IP, per email_hash).
 * In-process per isolate (standard for CF Workers). Separate from broker.
 * Bounds memory, fails closed.
 */

import type { Clock } from "./clock.js";

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  clock?: Clock;
  maxKeys?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface RateLimiter {
  check(key: string): RateLimitResult;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const clock = options.clock ?? { nowMs: () => Date.now() };
  const maxKeys = options.maxKeys ?? 4096;
  const windows = new Map<string, { start: number; count: number }>();

  function sweep(now: number) {
    for (const [k, e] of windows) {
      if (now - e.start >= options.windowMs) windows.delete(k);
    }
  }

  return {
    check(key: string) {
      const now = clock.nowMs();
      let entry = windows.get(key);
      if (!entry || now - entry.start >= options.windowMs) {
        if (windows.size >= maxKeys && !windows.has(key)) {
          sweep(now);
          if (windows.size >= maxKeys) {
            return { allowed: false, remaining: 0, retryAfterMs: options.windowMs };
          }
        }
        entry = { start: now, count: 1 };
        windows.set(key, entry);
        return { allowed: true, remaining: options.limit - 1, retryAfterMs: options.windowMs };
      }
      entry.count += 1;
      const allowed = entry.count <= options.limit;
      const remaining = Math.max(0, options.limit - entry.count);
      const retryAfterMs = Math.max(0, entry.start + options.windowMs - now);
      if (windows.size >= maxKeys) sweep(now);
      return { allowed, remaining, retryAfterMs };
    }
  };
}

export function rateLimitKeyForSignup(peer: string | undefined): string {
  return `signup:${peer ?? "anon"}`;
}

export function rateLimitKeyForEmailHash(emailHash: string): string {
  // per-email_hash daily budget; use coarse day key
  const day = Math.floor(Date.now() / (24 * 3600 * 1000));
  return `email:${emailHash}:${day}`;
}

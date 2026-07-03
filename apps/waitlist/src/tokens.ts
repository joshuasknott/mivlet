/**
 * Token generation and hashing. Tokens are NEVER stored in plaintext.
 * Only hashes are persisted.
 */

import { randomBytes, base64url, sha256 } from "./crypto.js";

export const CONFIRM_TOKEN_BYTES = 32;
export const CONFIRM_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours

export function generateConfirmToken(): string {
  return base64url(randomBytes(CONFIRM_TOKEN_BYTES));
}

export async function hashToken(token: string): Promise<string> {
  return await sha256(token);
}

export function isExpired(expiresAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!expiresAt) return true;
  const t = Date.parse(expiresAt);
  return isNaN(t) || t <= now.getTime();
}

export function computeExpiry(now: Date = new Date()): string {
  return new Date(now.getTime() + CONFIRM_TTL_MS).toISOString();
}

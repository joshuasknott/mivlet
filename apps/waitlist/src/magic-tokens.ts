/**
 * Centralized magic token issuance and redemption.
 * Pure functions that use the provided services (db + clock + optional capture).
 * Used by all flows: confirm (for unsub), requestExport, requestDelete, etc.
 * Never logs raw tokens; capture is test-only and in-memory.
 */

import { generateConfirmToken, hashToken, computeExpiry } from "./tokens.js";
import type { WaitlistServices } from "./waitlist.js";

export type MagicTokenType = 'export' | 'delete' | 'unsub';

export interface IssuedToken {
  type: MagicTokenType;
  token: string; // plaintext only returned to caller (for email/dev capture); never logged raw
  subscriberId: string;
}

export interface TokenCapture {
  issued: IssuedToken[];
}

export async function issueMagicToken(
  subscriberId: string,
  type: MagicTokenType,
  services: WaitlistServices
): Promise<string> {
  const token = generateConfirmToken();
  const h = await hashToken(token);
  const exp = computeExpiry(new Date(services.clock.nowMs()));
  const now = services.clock.nowIso();
  await services.db.createMagicToken(subscriberId, type, h, exp, now);

  // Test-only capture (no-op in prod; never logs PII)
  if (services.capture) {
    services.capture.issued.push({ type, token, subscriberId });
  }

  return token;
}

export async function redeemMagicToken(
  token: string,
  type: MagicTokenType,
  services: WaitlistServices
): Promise<{ subscriberId: string } | null> {
  const h = await hashToken(token);
  const now = services.clock.nowIso();
  const magic = await services.db.getMagicToken(h, type, now);
  if (!magic) return null;

  // consume immediately (single-use)
  await services.db.consumeMagicToken(h);

  return { subscriberId: magic.subscriber_id };
}

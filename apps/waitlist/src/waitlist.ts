/**
 * Core waitlist business logic. Deterministic where possible.
 * Duplicate handling: pending/confirmed return identical 202, no existence leak.
 * Tokens only ever stored hashed.
 */

import { randomUUID } from "./uuid.js"; // simple uuid
import { normalizeEmail, isValidEmail, boundPlatformInterest, boundConnectorInterest, boundReferralCode, boundLocale, isHoneypotFilled } from "./validation.js";
import { computeConsentTextHash, verifyConsent } from "./consent.js";
import { generateConfirmToken, hashToken, computeExpiry, isExpired } from "./tokens.js";
import { createRateLimiter, rateLimitKeyForSignup, rateLimitKeyForEmailHash } from "./rate-limiter.js";
import type { WaitlistDB } from "./db.js";
import type { SignupInput, SignupResult, SubscriberStatus } from "./types.js";
import { hmacSha256, encryptEmail } from "./crypto.js";

export interface WaitlistEnv {
  DB: D1Database; // from cf
  TURNSTILE_SECRET: string;
  WAITLIST_EMAIL_PEPPER: string;
  WAITLIST_SIGNING_KEY: string; // for future signed links
  MARKETING_ORIGIN?: string;
  CONFIRM_URL_BASE?: string;
  RATE_LIMIT_SIGNUP_PER_HOUR?: string;
  RATE_LIMIT_EMAIL_PER_DAY?: string;
}

export interface WaitlistServices {
  db: WaitlistDB;
  verifyTurnstile: (token: string, ip?: string) => Promise<boolean>;
  clock: { nowMs: () => number; nowIso: () => string };
  log: (msg: string) => void; // redacted only
}

function makeRedactedLog(base: (s: string) => void) {
  return (s: string) => {
    // Never log raw email, token, ip, body
    const red = s
      .replace(/[\w.+-]+@[\w.-]+\.\w+/g, "[email-redacted]")
      .replace(/[A-Za-z0-9_-]{24,}/g, (m) => (m.length > 30 ? "[token-redacted]" : m))
      .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "[ip-redacted]");
    base(red);
  };
}

export async function signup(
  input: SignupInput,
  ip: string | undefined,
  services: WaitlistServices,
  env: WaitlistEnv
): Promise<{ result?: SignupResult; status: number; error?: { code: string; message: string } }> {
  const log = makeRedactedLog(services.log || console.log.bind(console));

  // Honeypot
  if (isHoneypotFilled(input.website)) {
    log("honeypot filled (silent 202)");
    return { status: 202, result: { id: "00000000-0000-0000-0000-000000000000", status: "pending" } };
  }

  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) {
    return { status: 400, error: { code: "invalid-request", message: "Invalid email" } };
  }

  // Consent server recompute
  const consentCheck = await verifyConsent(input.consent_version);
  if (!consentCheck.ok) {
    return { status: 400, error: { code: "consent-invalid", message: "Invalid consent version" } };
  }
  if (!input.consent_marketing) {
    return { status: 400, error: { code: "consent-invalid", message: "Marketing consent required" } };
  }

  const emailHash = await hmacSha256(env.WAITLIST_EMAIL_PEPPER, email);
  const nowIso = services.clock.nowIso();

  // Rate limit IP
  const ipLimit = createRateLimiter({ limit: parseInt(env.RATE_LIMIT_SIGNUP_PER_HOUR || "10", 10), windowMs: 3600_000 });
  const ipRes = ipLimit.check(rateLimitKeyForSignup(ip));
  if (!ipRes.allowed) {
    return { status: 429, error: { code: "rate-limited", message: "Too many requests" } };
  }

  // Rate per email_hash (daily)
  const emailLimit = createRateLimiter({ limit: parseInt(env.RATE_LIMIT_EMAIL_PER_DAY || "3", 10), windowMs: 24 * 3600_000 });
  const eRes = emailLimit.check(rateLimitKeyForEmailHash(emailHash));
  if (!eRes.allowed) {
    // silent duplicate-like
    log("email rate limited (silent)");
    const id = randomUUID();
    return { status: 202, result: { id, status: "pending" } };
  }

  // Turnstile (real or test mode)
  const tsOk = await services.verifyTurnstile(input.turnstile_token, ip);
  if (!tsOk) {
    return { status: 400, error: { code: "turnstile-failed", message: "Verification failed" } };
  }

  const existing = await services.db.findByEmailHash(emailHash);
  if (existing && (existing.status === "pending" || existing.status === "confirmed")) {
    // Duplicate safe: identical response, do not leak. Optionally refresh token if pending expired.
    if (existing.status === "pending" && isExpired(existing.confirm_expires_at)) {
      const newTok = generateConfirmToken();
      const newHash = await hashToken(newTok);
      const newExp = computeExpiry(new Date(services.clock.nowMs()));
      await services.db.updateConfirmToken(existing.id, newHash, newExp, nowIso);
      // In real would send email here using newTok (but never log)
    }
    log("duplicate signup (silent 202)");
    return { status: 202, result: { id: existing.id, status: "pending" } };
  }

  // New pending row
  const id = randomUUID();
  const cipher = await encryptEmail(email, env.WAITLIST_EMAIL_PEPPER);
  const tok = generateConfirmToken();
  const tokHash = await hashToken(tok);
  const exp = computeExpiry(new Date(services.clock.nowMs()));

  const platform = boundPlatformInterest(input.platform_interest);
  const conns = JSON.stringify(boundConnectorInterest(input.connector_interest));
  const ref = boundReferralCode(input.referral_code);
  const loc = boundLocale("en"); // passed from handler typically

  await services.db.insertPending({
    id,
    emailCipher: cipher,
    emailHash,
    consentVersion: input.consent_version,
    consentTextHash: consentCheck.hash,
    consentMarketing: true,
    platform,
    connectorsJson: conns,
    referral: ref || null,
    locale: loc || null,
    confirmTokenHash: tokHash,
    confirmExpires: exp,
    now: nowIso
  });

  // Audit consent (immutable)
  // (omitted insert for brevity in core; handler can do)

  log("signup created pending");
  return { status: 202, result: { id, status: "pending" } };
}

export async function confirm(token: string, services: WaitlistServices): Promise<{ status: SubscriberStatus } | { error: { code: string; message: string } }> {
  if (!token || token.length < 32) {
    return { error: { code: "token-invalid", message: "Invalid token" } };
  }
  const h = await hashToken(token);
  const row = await services.db.getByConfirmTokenHash(h, services.clock.nowIso());
  if (!row) {
    return { error: { code: "token-invalid", message: "Invalid token" } };
  }
  if (isExpired(row.confirm_expires_at)) {
    return { error: { code: "token-expired", message: "Token expired" } };
  }
  if (row.status !== "pending") {
    // already confirmed or other
    return { status: row.status };
  }
  const now = services.clock.nowIso();
  await services.db.markConfirmed(row.id, now);
  return { status: "confirmed" };
}

// Additional flows (unsub, delete, export) follow same pattern: token hash lookup, no plaintext token in DB.
// Stubs for completeness; full in router handler tests drive them.
export async function unsubscribe(token: string, services: WaitlistServices) {
  // Similar hash lookup + update status
  const h = await hashToken(token);
  const row = await services.db.getByConfirmTokenHash(h, services.clock.nowIso()); // reuse for unsub token concept (separate in full)
  if (!row) return { error: { code: "token-invalid", message: "Invalid" } };
  await services.db.setUnsubscribed(row.id, services.clock.nowIso());
  return { status: "unsubscribed" as const };
}

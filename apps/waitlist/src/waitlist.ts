/**
 * Core waitlist business logic. Deterministic where possible.
 * Duplicate handling: pending/confirmed return identical 202, no existence leak.
 * Tokens only ever stored hashed.
 */

import { randomUUID } from "./uuid.js"; // simple uuid
import { normalizeEmail, isValidEmail, boundPlatformInterest, boundConnectorInterest, boundReferralCode, boundLocale, isHoneypotFilled } from "./validation.js";
import { computeConsentTextHash, verifyConsent } from "./consent.js";
import { generateConfirmToken, hashToken, computeExpiry, isExpired } from "./tokens.js";
import { createRateLimiter, rateLimitKeyForSignup, rateLimitKeyForEmailHash, type RateLimiter } from "./rate-limiter.js";
import type { WaitlistDB } from "./db.js";
import type { SignupInput, SignupResult, SubscriberStatus } from "./types.js";
import { hmacSha256, encryptEmail } from "./crypto.js";
import { issueMagicToken, redeemMagicToken, type MagicTokenType } from "./magic-tokens.js";

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
  signupLimiter?: RateLimiter;
  emailLimiter?: RateLimiter;
  /** Test-only capture for issued magic tokens (populated by issueMagicToken; no-op in production). */
  capture?: { issued: Array<{ type: string; token: string; subscriberId: string }> };
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
  const ipLimit = services.signupLimiter ?? createRateLimiter({ limit: parseInt(env.RATE_LIMIT_SIGNUP_PER_HOUR || "10", 10), windowMs: 3600_000, clock: services.clock });
  const ipRes = ipLimit.check(rateLimitKeyForSignup(ip));
  if (!ipRes.allowed) {
    return { status: 429, error: { code: "rate-limited", message: "Too many requests" } };
  }

  // Rate per email_hash (daily)
  const emailLimit = services.emailLimiter ?? createRateLimiter({ limit: parseInt(env.RATE_LIMIT_EMAIL_PER_DAY || "3", 10), windowMs: 24 * 3600_000, clock: services.clock });
  const eRes = emailLimit.check(rateLimitKeyForEmailHash(emailHash, services.clock.nowMs()));
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
  const loc = boundLocale(input.locale);

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

  // Per spec: issue unsub magic token on confirm (emailed in real; captured in tests via services.capture)
  // This ensures a real shipped path creates 'unsub' tokens needed for later unsubscribe.
  await issueMagicToken(row.id, "unsub", services);

  return { status: "confirmed" };
}

// Additional flows (unsub, delete, export) follow same pattern: token hash lookup, no plaintext token in DB.
// Stubs for completeness; full in router handler tests drive them.
export async function unsubscribe(token: string, services: WaitlistServices) {
  const redeemed = await redeemMagicToken(token, "unsub", services);
  if (!redeemed) return { error: { code: "token-invalid", message: "Invalid token" } };
  const now = services.clock.nowIso();
  await services.db.setUnsubscribed(redeemed.subscriberId, now);
  return { status: "unsubscribed" as const };
}

export async function requestExport(email: string, services: WaitlistServices, env: WaitlistEnv) {
  const norm = normalizeEmail(email);
  if (!isValidEmail(norm)) return { status: 202 }; // always accept
  const hash = await hmacSha256(env.WAITLIST_EMAIL_PEPPER, norm);
  const row = await services.db.findByEmailHashForMagic(hash);
  if (!row) return { status: 202 };
  // Centralized issuance (will also populate test capture if present)
  await issueMagicToken(row.id, "export", services);
  // In real: email the token link using CONFIRM_URL_BASE or equiv. Here we never log token.
  return { status: 202 };
}

export async function performExport(token: string, services: WaitlistServices, emailKey: string) {
  const redeemed = await redeemMagicToken(token, "export", services);
  if (!redeemed) return { error: { code: "token-invalid", message: "Invalid or expired" } };
  const data = await services.db.exportForId(redeemed.subscriberId, emailKey);
  if (!data) return { error: { code: "not-found", message: "Not found" } };
  return { status: 200, data };
}

export async function requestDelete(email: string, services: WaitlistServices, env: WaitlistEnv) {
  const norm = normalizeEmail(email);
  if (!isValidEmail(norm)) return { status: 202 };
  const hash = await hmacSha256(env.WAITLIST_EMAIL_PEPPER, norm);
  const row = await services.db.findByEmailHashForMagic(hash);
  if (!row) return { status: 202 };
  await issueMagicToken(row.id, "delete", services);
  return { status: 202 };
}

// Back-compat wrapper (prefer issueMagicToken directly). Kept so existing test imports continue to work during transition.
export async function issueUnsubscribeToken(subscriberId: string, services: WaitlistServices): Promise<string> {
  return issueMagicToken(subscriberId, "unsub", services);
}

export async function doDelete(token: string, services: WaitlistServices) {
  const redeemed = await redeemMagicToken(token, "delete", services);
  if (!redeemed) return { error: { code: "token-invalid", message: "Invalid or expired token" } };
  const now = services.clock.nowIso();
  await services.db.setDeleted(redeemed.subscriberId, now);
  // For hard delete after hold, operator can call hardDelete later; here soft + consume
  return { status: "deleted" as const };
}

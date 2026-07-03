/**
 * Server-side validation, normalization, bounding for waitlist.
 * Pure functions, fully deterministic and testable.
 */

export type PlatformInterest = "windows" | "macos" | "linux" | "unspecified";

export const ALLOWED_CONNECTORS = [
  "local-files",
  "github",
  "vercel",
  "google-drive",
  "gmail",
  "google-calendar",
  "notion",
  "slack",
  "linear"
] as const;

export type ConnectorId = (typeof ALLOWED_CONNECTORS)[number];

const EMAIL_MAX = 254;
const REFERRAL_MAX = 32;
const LOCALE_MAX = 35;
const CONNECTOR_MAX = 9;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // pragmatic RFC subset, no full parser needed

export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  if (!email || email.length > EMAIL_MAX) return false;
  return EMAIL_RE.test(email);
}

export function isValidConsentMarketing(v: unknown): v is true {
  return v === true;
}

export function isValidConsentVersion(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}-waitlist-v\d+\.\d+$/.test(v);
}

export function boundReferralCode(code: unknown): string | undefined {
  if (typeof code !== "string") return undefined;
  const trimmed = code.trim();
  if (trimmed.length === 0 || trimmed.length > REFERRAL_MAX) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

export function boundLocale(locale: unknown): string | undefined {
  if (typeof locale !== "string") return undefined;
  const t = locale.trim().slice(0, LOCALE_MAX);
  return t.length > 0 ? t : undefined;
}

export function boundPlatformInterest(p: unknown): PlatformInterest {
  if (p === "macos" || p === "linux" || p === "unspecified") return p;
  return "windows";
}

export function boundConnectorInterest(arr: unknown): ConnectorId[] {
  if (!Array.isArray(arr)) return [];
  const out: ConnectorId[] = [];
  for (const v of arr) {
    if (typeof v === "string" && (ALLOWED_CONNECTORS as readonly string[]).includes(v)) {
      if (!out.includes(v as ConnectorId)) {
        out.push(v as ConnectorId);
      }
      if (out.length >= CONNECTOR_MAX) break;
    }
  }
  return out;
}

export function isHoneypotFilled(website: unknown): boolean {
  return typeof website === "string" && website.trim().length > 0;
}

/** Very rough MX hint (non-blocking in prod; DNS not required for acceptance) */
export function looksLikeEmailDomain(email: string): boolean {
  return email.includes(".");
}

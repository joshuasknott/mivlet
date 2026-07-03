/**
 * Versioned consent handling with SERVER-OWNED hash.
 * Client sends version + we recompute hash from our manifest.
 * Never trusts client-provided hash for consent_text_hash.
 */

import manifest from "./consent-manifest.json" assert { type: "json" };
import { sha256 } from "./crypto.js";

export type ConsentVersion = keyof typeof manifest.versions;

export function isKnownConsentVersion(v: string): v is ConsentVersion {
  return Object.prototype.hasOwnProperty.call(manifest.versions, v);
}

export async function computeConsentTextHash(version: string): Promise<string> {
  if (!isKnownConsentVersion(version)) {
    throw new Error("unknown_consent_version");
  }
  const text = manifest.versions[version].canonicalText;
  return await sha256(text);
}

export function getCheckboxLabel(version: ConsentVersion): string {
  return manifest.versions[version].checkboxLabel;
}

export async function verifyConsent(
  version: unknown,
  clientProvidedHash?: unknown
): Promise<{ ok: true; version: ConsentVersion; hash: string } | { ok: false; code: string }> {
  if (typeof version !== "string" || !isKnownConsentVersion(version)) {
    return { ok: false, code: "consent-invalid" };
  }
  const expectedHash = await computeConsentTextHash(version);
  // If client sends one we still ignore for storage; we always use server hash.
  // But we can optionally validate if present for extra defense (not required).
  const v: ConsentVersion = version;
  return { ok: true, version: v, hash: expectedHash };
}

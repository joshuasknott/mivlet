/**
 * PKCE helpers for the broker's own verifier (broker-pkce providers). The desktop
 * owns the PKCE verifier for the broker→desktop trust; the broker owns a separate
 * verifier for the broker→provider confidential exchange where the provider
 * requires it.
 */

import { createHash, randomBytes } from "node:crypto";

/** Generate a high-entropy PKCE verifier. */
export function generateVerifier(): string {
  return randomBytes(48).toString("base64url");
}

/** S256 code challenge for a verifier. */
export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export interface BrokerPkcePair {
  verifier: string;
  challenge: string;
}

/** Generate a verifier + its S256 challenge. */
export function generatePkcePair(): BrokerPkcePair {
  const verifier = generateVerifier();
  return { verifier, challenge: challengeFor(verifier) };
}

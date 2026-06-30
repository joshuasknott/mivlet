/**
 * PKCE helpers for the broker's own verifier (broker-pkce providers). The desktop
 * owns the PKCE verifier for the broker→desktop trust; the broker owns a separate
 * verifier for the broker→provider confidential exchange where the provider
 * requires it.
 */

import { randomBase64Url, sha256Base64Url } from "./crypto.js";

/** Generate a high-entropy PKCE verifier. */
export function generateVerifier(): string {
  return randomBase64Url(48);
}

/** S256 code challenge for a verifier. */
export async function challengeFor(verifier: string): Promise<string> {
  return sha256Base64Url(verifier);
}

export interface BrokerPkcePair {
  verifier: string;
  challenge: string;
}

/** Generate a verifier + its S256 challenge. */
export async function generatePkcePair(): Promise<BrokerPkcePair> {
  const verifier = generateVerifier();
  return { verifier, challenge: await challengeFor(verifier) };
}

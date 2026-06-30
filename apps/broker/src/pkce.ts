/**
 * PKCE helpers for the broker's own verifier (broker-pkce providers). The desktop
 * owns the PKCE verifier for the broker→desktop trust; the broker owns a separate
 * verifier for the broker→provider confidential exchange where the provider
 * requires it.
 *
 * Implemented against the Web Crypto API (see `crypto-web.ts`) so the broker
 * core runs on both Node.js and the Cloudflare Workers runtime.
 */

import { base64url, randomBytes, sha256 } from "./crypto-web.js";

/** Generate a high-entropy PKCE verifier. */
export function generateVerifier(): string {
  return base64url(randomBytes(48));
}

/** S256 code challenge for a verifier (base64url, no padding). */
export async function challengeFor(verifier: string): Promise<string> {
  return base64url(await sha256(verifier));
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

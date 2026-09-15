/**
 * PKCE helpers for both hops the broker participates in.
 *
 * Desktop → broker: the desktop owns the verifier (OS keyring). The broker
 * stores the S256 challenge from authorize and checks it at handoff redeem.
 *
 * Broker → provider: for `broker-pkce` providers the broker generates a
 * separate verifier/challenge and uses that pair on the confidential exchange.
 * That challenge is never the desktop's.
 *
 * Implemented against the Web Crypto API (see `crypto-web.ts`) so the broker
 * core runs on both Node.js and the Cloudflare Workers runtime.
 */

import { base64url, randomBytes, sha256, timingSafeEqualUtf8 } from "./crypto-web.js";

/** Generate a high-entropy PKCE verifier. */
function generateVerifier(): string {
  return base64url(randomBytes(48));
}

/** S256 code challenge for a verifier (base64url, no padding). */
export async function s256Challenge(verifier: string): Promise<string> {
  return base64url(await sha256(verifier));
}

export interface BrokerPkcePair {
  verifier: string;
  challenge: string;
}

/** Generate a verifier + its S256 challenge. */
export async function generatePkcePair(): Promise<BrokerPkcePair> {
  const verifier = generateVerifier();
  return { verifier, challenge: await s256Challenge(verifier) };
}

/** Constant-time S256 check. Length mismatches still walk the longer digest. */
export async function verifierMatchesS256Challenge(
  verifier: string,
  challenge: string
): Promise<boolean> {
  return timingSafeEqualUtf8(await s256Challenge(verifier), challenge);
}

/**
 * Web Crypto helpers shared by the broker core.
 *
 * The broker must run on both Node.js (local dev / `server.ts`) and the
 * Cloudflare Workers runtime. The Workers runtime does NOT provide Node's
 * `crypto` module or the `Buffer` global, so every cryptographic primitive the
 * core needs is implemented here against the Web Crypto API, which is available
 * on both runtimes. `globalThis.crypto` (Crypto) is standard on Node >= 19 and
 * Workers.
 *
 * Everything here is secret-handling-adjacent, so the helpers are deliberately
 * minimal and side-effect free: random bytes, SHA-256 (for PKCE S256), and
 * base64/base64url encodings of byte strings.
 */

/**
 * Cryptographically strong random bytes, returned as a byte array. Uses the
 * platform Web Crypto `getRandomValues`, which never rejects and is available
 * on every target the broker supports.
 */
export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/**
 * Module-level UTF-8 encoder, reused across every encode call. `TextEncoder` is
 * stateless and allocation is cheap, but the broker encodes on every PKCE digest
 * and Basic-auth header, so hoisting it avoids a per-call allocation. Stateless
 * encoder → safe to share across calls.
 */
const TEXT_ENCODER = new TextEncoder();

/**
 * SHA-256 digest of a UTF-8 string, as raw bytes. Used for the PKCE S256 code
 * challenge. Implemented against Web Crypto `digest` so no Node API is touched.
 */
export async function sha256(input: string): Promise<Uint8Array> {
  const data = TEXT_ENCODER.encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

/** Base64url-encode a byte array with no padding (RFC 7636 / RFC 4648 §5). */
export function base64url(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Standard (padded) base64 of a byte array. Replaces `Buffer.from(x).toString("base64")`
 * on runtimes (Workers) that lack a `Buffer` global.
 */
export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Base64-encode a UTF-8 string (e.g. `client_id:client_secret` for Basic auth). */
export function base64String(input: string): string {
  return base64(TEXT_ENCODER.encode(input));
}

const TEXT_DECODER = new TextDecoder();

/** Decode base64url (no pad) to bytes. Inverse of base64url(). */
export function base64urlToBytes(input: string): Uint8Array {
  let b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  switch (b64.length % 4) {
    case 0: break;
    case 2: b64 += "=="; break;
    case 3: b64 += "="; break;
    default: throw new Error("invalid base64url length");
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** UTF-8 encode (hoisted). */
export function utf8Encode(s: string): Uint8Array {
  return TEXT_ENCODER.encode(s);
}

/** UTF-8 decode. */
export function utf8Decode(bytes: Uint8Array): string {
  return TEXT_DECODER.decode(bytes);
}

/**
 * Constant-time equality for UTF-8 strings. Length mismatches still compare
 * against a dummy walk so short values do not return early.
 */
export function timingSafeEqualUtf8(left: string, right: string): boolean {
  const a = TEXT_ENCODER.encode(left);
  const b = TEXT_ENCODER.encode(right);
  const n = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < n; i++) {
    mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return mismatch === 0;
}

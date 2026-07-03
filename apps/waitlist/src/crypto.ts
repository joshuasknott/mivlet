/**
 * Web Crypto helpers for waitlist Worker.
 * Available in Workers + recent Node. No Node 'crypto' dep.
 */

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function base64url(bytes: Uint8Array): string {
  // Standard base64url without padding for tokens
  let b64 = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(text: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(text);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hmacSha256(key: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const keyData = enc.encode(key);
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Minimal AES-GCM "at rest" simulation for waitlist email.
 * In real deployment the key material comes from a secret + KMS rotation.
 * The returned "ciphertext" is base64url(iv+cipher).
 * We never expose raw key.
 */
export async function encryptEmail(plain: string, keyMaterial: string): Promise<string> {
  const enc = new TextEncoder();
  const keyBytes = await globalThis.crypto.subtle.digest("SHA-256", enc.encode("waitlist-email-enc:" + keyMaterial));
  const key = await globalThis.crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = randomBytes(12);
  const ct = await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as any }, key, enc.encode(plain));
  const combined = new Uint8Array(iv.length + (ct as ArrayBuffer).byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct as ArrayBuffer), iv.length);
  return base64url(combined);
}

export async function decryptEmail(cipher: string, keyMaterial: string): Promise<string> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const keyBytes = await globalThis.crypto.subtle.digest("SHA-256", enc.encode("waitlist-email-enc:" + keyMaterial));
  const key = await globalThis.crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const combined = Uint8Array.from(atob(cipher.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const plain = await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as any }, key, ct as any);
  return dec.decode(plain);
}


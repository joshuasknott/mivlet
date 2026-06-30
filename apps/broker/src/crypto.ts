const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Generate a cryptographically random base64url token without Node APIs. */
export function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  let output = "";
  for (const byte of bytes) {
    output += BASE64URL_ALPHABET[byte & 0x3f];
  }
  return output;
}

/** SHA-256 digest encoded as unpadded base64url. */
export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return base64UrlEncode(new Uint8Array(digest));
}

/** Standard base64 for HTTP Basic auth credentials. */
export function base64Encode(input: string): string {
  return bytesToBase64(new TextEncoder().encode(input));
}

function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary);
}

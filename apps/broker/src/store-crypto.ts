/**
 * Pure, side-effect-free encryption helpers for broker Durable Object stores.
 *
 * All sensitive values (PKCE verifiers for broker-pkce providers, desktop
 * PKCE challenges bound into pending rows, and full token+account payloads
 * for handoffs) are encrypted with AES-256-GCM before any write to DO SQLite.
 *
 * Design:
 * - Versioned envelope byte + nonce(12) || ciphertext+tag
 * - HKDF-SHA-256 per-record key derivation (salt = id hash, info = v1:kind)
 * - AAD binds provider + id + (for handoff) state to prevent swap/replay across rows
 * - Never logs, never persists plaintext or keys.
 * - Deterministic for given inputs + secret (except random nonce).
 * - Fails closed on missing/ invalid secret or corrupt ciphertext.
 *
 * Used only by durable adapters; memory path and Node tests never call here.
 */

import type { BrokerProviderId } from "@mivlet/connectors";
import {
  base64url,
  base64urlToBytes,
  randomBytes,
  sha256,
  utf8Decode,
  utf8Encode
} from "./crypto-web.js";

const ENVELOPE_VERSION = 1;
const HKDF_INFO_PENDING = "mivlet-broker-store:v1:pending-verifier";
const HKDF_INFO_HANDOFF = "mivlet-broker-store:v1:handoff-payload";

const TEXT_ENCODER = new TextEncoder(); // local for AAD consts if needed

export interface HandoffPayload {
  tokens: unknown; // ConnectorTokenSet at runtime
  account: unknown; // ConnectorAccountSummary
  /** Desktop S256 challenge proven at redeem. */
  codeChallenge: string;
}

/** Desktop challenge plus optional broker-generated verifier, stored together. */
export interface PendingRecordSecrets {
  verifier?: string;
  codeChallenge: string;
}

/** Thrown only for crypto failures inside durable path (never surface raw). */
export class StoreCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreCryptoError";
  }
}

/** Decode the required base64url secret (must be exactly 32 bytes after decode). */
function decodeMasterSecret(secret: string): Uint8Array {
  if (!secret || typeof secret !== "string") {
    throw new StoreCryptoError("encryption key missing");
  }
  let raw: Uint8Array;
  try {
    raw = base64urlToBytes(secret);
  } catch {
    throw new StoreCryptoError("encryption key invalid");
  }
  if (raw.length !== 32) {
    throw new StoreCryptoError("encryption key invalid length");
  }
  return raw;
}

/** Validate the durable-store root key during Worker runtime construction. */
export function assertStoreEncryptionKey(secret: string): void {
  decodeMasterSecret(secret);
}

async function importMasterKey(raw: Uint8Array): Promise<CryptoKey> {
  // @ts-ignore -- subtle param types (HKDF/AES + buffer) vary across TS lib configs
  return globalThis.crypto.subtle.importKey(
    "raw",
    raw as any,
    { name: "HKDF" },
    false,
    ["deriveKey"]
  );
}

async function deriveRecordKey(
  master: CryptoKey,
  salt: Uint8Array,
  info: string
): Promise<CryptoKey> {
  // @ts-ignore -- subtle param types (HKDF/AES + buffer) vary across TS lib configs
  return globalThis.crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as any,
      info: utf8Encode(info) as any
    },
    master,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function aesGcmEncrypt(
  key: CryptoKey,
  plaintext: any,
  aad: any
): Promise<Uint8Array> {
  const nonce = randomBytes(12);
  // @ts-ignore -- BufferSource / ArrayBufferView + SharedArrayBuffer lib diff (Node tsc vs CF)
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as any, additionalData: aad as any },
    key,
    plaintext as any
  );
  const ctBytes = new Uint8Array(ct);
  const out = new Uint8Array(1 + 12 + ctBytes.length);
  out[0] = ENVELOPE_VERSION;
  out.set(nonce, 1);
  out.set(ctBytes, 1 + 12);
  return out;
}

async function aesGcmDecrypt(
  key: CryptoKey,
  blob: any,
  aad: any
): Promise<Uint8Array> {
  if (blob.length < 1 + 12 + 16) {
    throw new StoreCryptoError("ciphertext too short");
  }
  const ver = blob[0];
  if (ver !== ENVELOPE_VERSION) {
    throw new StoreCryptoError("unsupported envelope version");
  }
  const nonce = blob.subarray(1, 13);
  const data = blob.subarray(13);
  try {
    // @ts-ignore -- BufferSource / ArrayBufferView + SharedArrayBuffer lib diff (Node tsc vs CF)
    const pt = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as any, additionalData: aad as any },
      key,
      data as any
    );
    return new Uint8Array(pt);
  } catch {
    // Any GCM failure (tag, AAD mismatch, bit flip) -> fail closed as corruption
    throw new StoreCryptoError("decryption failed");
  }
}

/** Compute the stable hash used both for DO idFromName and as key salt. */
export async function computeStateHash(state: string): Promise<string> {
  if (!state || state.length < 16 || state.length > 512) {
    throw new StoreCryptoError("invalid state for hash");
  }
  return base64url(await sha256(state));
}

export async function computeHandoffHash(ticket: string): Promise<string> {
  if (!ticket || ticket.length < 16) {
    throw new StoreCryptoError("invalid handoff for hash");
  }
  return base64url(await sha256(ticket));
}

export async function computeRateLimitHash(route: string, peerKey: string): Promise<string> {
  // peerKey should be short derived, route is path
  const input = `${route}\0${peerKey}`;
  return base64url(await sha256(input));
}

/** Derive a short (32 hex chars = 16 bytes) peer key from raw peer (e.g. CF-Connecting-IP). Never log raw. */
export async function derivePeerKey(peer: string | undefined): Promise<string> {
  const p = peer ?? "anonymous";
  const h = await sha256(p);
  // first 16 bytes -> hex
  const hex = Array.from(h.subarray(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex;
}

/**
 * Encrypt pending PKCE bindings (desktop challenge + optional broker verifier).
 * AAD binds provider + stateHash so the blob cannot be moved.
 */
export async function encryptPendingSecrets(
  secret: string,
  state: string,
  provider: BrokerProviderId,
  secrets: PendingRecordSecrets
): Promise<Uint8Array> {
  const stateHash = await computeStateHash(state);
  const raw = decodeMasterSecret(secret);
  const master = await importMasterKey(raw);
  const salt = utf8Encode(stateHash);
  const key = await deriveRecordKey(master, salt, HKDF_INFO_PENDING);
  const aad = utf8Encode(`pending:${provider}:${stateHash}`);
  return aesGcmEncrypt(key, utf8Encode(JSON.stringify(secrets)), aad);
}

/** Decrypt pending PKCE bindings. Throws on corruption, key error, or malformed JSON. */
export async function decryptPendingSecrets(
  secret: string,
  stateHash: string,
  provider: BrokerProviderId,
  blob: Uint8Array
): Promise<PendingRecordSecrets> {
  const raw = decodeMasterSecret(secret);
  const master = await importMasterKey(raw);
  const salt = utf8Encode(stateHash);
  const key = await deriveRecordKey(master, salt, HKDF_INFO_PENDING);
  const aad = utf8Encode(`pending:${provider}:${stateHash}`);
  const pt = await aesGcmDecrypt(key, blob, aad);
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(pt));
  } catch {
    throw new StoreCryptoError("payload parse failed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StoreCryptoError("payload parse failed");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.codeChallenge !== "string" || !record.codeChallenge) {
    throw new StoreCryptoError("payload parse failed");
  }
  const secrets: PendingRecordSecrets = { codeChallenge: record.codeChallenge };
  if (record.verifier !== undefined) {
    if (typeof record.verifier !== "string" || !record.verifier) {
      throw new StoreCryptoError("payload parse failed");
    }
    secrets.verifier = record.verifier;
  }
  return secrets;
}

/**
 * Encrypt handoff payload (tokens + account + desktop PKCE challenge). Called after token exchange.
 * Ticket is generated before; hash used for routing and AAD.
 */
export async function encryptHandoffPayload(
  secret: string,
  ticket: string,
  provider: BrokerProviderId,
  state: string,
  payload: HandoffPayload
): Promise<Uint8Array> {
  const ticketHash = await computeHandoffHash(ticket);
  const raw = decodeMasterSecret(secret);
  const master = await importMasterKey(raw);
  const salt = utf8Encode(ticketHash);
  const key = await deriveRecordKey(master, salt, HKDF_INFO_HANDOFF);
  const aad = utf8Encode(`handoff:${provider}:${state}:${ticketHash}`);
  const json = JSON.stringify(payload);
  return aesGcmEncrypt(key, utf8Encode(json), aad);
}

/** Decrypt and parse handoff payload. */
export async function decryptHandoffPayload(
  secret: string,
  ticketHash: string,
  provider: BrokerProviderId,
  state: string,
  blob: Uint8Array
): Promise<HandoffPayload> {
  const raw = decodeMasterSecret(secret);
  const master = await importMasterKey(raw);
  const salt = utf8Encode(ticketHash);
  const key = await deriveRecordKey(master, salt, HKDF_INFO_HANDOFF);
  const aad = utf8Encode(`handoff:${provider}:${state}:${ticketHash}`);
  const pt = await aesGcmDecrypt(key, blob, aad);
  const json = utf8Decode(pt);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new StoreCryptoError("payload parse failed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StoreCryptoError("payload parse failed");
  }
  const payload = parsed as HandoffPayload;
  if (typeof payload.codeChallenge !== "string" || !payload.codeChallenge) {
    throw new StoreCryptoError("payload parse failed");
  }
  return payload;
}

/** For tests: check whether a blob looks like it could contain plaintext (heuristic). */
export function looksLikePlaintextToken(blobOrStr: Uint8Array | string): boolean {
  const s = typeof blobOrStr === "string" ? blobOrStr : utf8Decode(blobOrStr);
  return /"access_token"|"refresh_token"|ya29\.|gho_|Bearer\s+[A-Za-z0-9]/.test(s);
}

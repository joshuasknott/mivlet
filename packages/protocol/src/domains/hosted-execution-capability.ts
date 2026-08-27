export type HostedExecutionCapabilityScope =
  | "process:launch"
  | "process:inspect"
  | "process:kill"
  | "schedule:manage"
  | "browser:navigate"
  | "browser:act"
  | "browser:snapshot";

export interface HostedExecutionCapabilityPayload {
  version: 1;
  computerId: string;
  generation: number;
  scopes: HostedExecutionCapabilityScope[];
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export interface HostedExecutionCapabilityReceipt {
  runnerUrl: string;
  token: string;
  computerId: string;
  generation: number;
  expiresAt: number;
}

const TOKEN_PREFIX = "v1";
const MAX_TOKEN_CHARACTERS = 4_096;
const MAX_CAPABILITY_LIFETIME_MS = 5 * 60_000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const ALLOWED_SCOPES = new Set<HostedExecutionCapabilityScope>([
  "process:launch",
  "process:inspect",
  "process:kill",
  "schedule:manage",
  "browser:navigate",
  "browser:act",
  "browser:snapshot"
]);

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid-capability");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(base64 + padding);
  } catch {
    throw new Error("invalid-capability");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned.buffer;
}

async function capabilityKey(rootSecret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  if (rootSecret.length < 32) throw new Error("capability-configuration-required");
  const root = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`fable-hosted-execution-capability:v1:${rootSecret}`)
  );
  return crypto.subtle.importKey("raw", root, { name: "HMAC", hash: "SHA-256" }, false, usages);
}

function validatePayload(value: unknown): HostedExecutionCapabilityPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-capability");
  const payload = value as Partial<HostedExecutionCapabilityPayload>;
  if (
    payload.version !== 1
    || typeof payload.computerId !== "string"
    || !IDENTIFIER.test(payload.computerId)
    || typeof payload.generation !== "number"
    || !Number.isSafeInteger(payload.generation)
    || payload.generation < 1
    || !Array.isArray(payload.scopes)
    || payload.scopes.length < 1
    || payload.scopes.length > ALLOWED_SCOPES.size
    || payload.scopes.some((scope) => !ALLOWED_SCOPES.has(scope))
    || new Set(payload.scopes).size !== payload.scopes.length
    || typeof payload.issuedAt !== "number"
    || !Number.isSafeInteger(payload.issuedAt)
    || typeof payload.expiresAt !== "number"
    || !Number.isSafeInteger(payload.expiresAt)
    || payload.expiresAt <= payload.issuedAt
    || payload.expiresAt - payload.issuedAt > MAX_CAPABILITY_LIFETIME_MS
    || typeof payload.nonce !== "string"
    || !IDENTIFIER.test(payload.nonce)
  ) {
    throw new Error("invalid-capability");
  }
  return payload as HostedExecutionCapabilityPayload;
}

export async function signHostedExecutionCapability(
  rootSecret: string,
  payload: HostedExecutionCapabilityPayload
): Promise<string> {
  const valid = validatePayload(payload);
  const payloadBytes = new TextEncoder().encode(JSON.stringify(valid));
  const encodedPayload = encodeBase64Url(payloadBytes);
  const key = await capabilityKey(rootSecret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encodedPayload));
  return `${TOKEN_PREFIX}.${encodedPayload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function verifyHostedExecutionCapability(
  rootSecret: string,
  token: string,
  expected: { computerId: string; scope: HostedExecutionCapabilityScope; now?: number }
): Promise<HostedExecutionCapabilityPayload> {
  if (!token || token.length > MAX_TOKEN_CHARACTERS) throw new Error("invalid-capability");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[1] || !parts[2]) {
    throw new Error("invalid-capability");
  }
  const key = await capabilityKey(rootSecret, ["verify"]);
  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    ownedArrayBuffer(decodeBase64Url(parts[2])),
    new TextEncoder().encode(parts[1])
  );
  if (!verified) throw new Error("invalid-capability");
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(parts[1])));
  } catch {
    throw new Error("invalid-capability");
  }
  const payload = validatePayload(decoded);
  const now = expected.now ?? Date.now();
  if (
    payload.computerId !== expected.computerId
    || !payload.scopes.includes(expected.scope)
    || now < payload.issuedAt - 30_000
    || now >= payload.expiresAt
  ) {
    throw new Error("capability-rejected");
  }
  return payload;
}

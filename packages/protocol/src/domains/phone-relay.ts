/** Managed phone transport. Native remains the sole task/grant authority. */
export const PHONE_RELAY_LIMITS = Object.freeze({
  bodyBytes: 65_536,
  frameBytes: 71_680,
  inFlight: 16,
  requestMs: 10_000,
  capabilityMs: 120_000,
  sessionMs: 8 * 60 * 60 * 1_000,
  requestsPerMinute: 240,
});

export interface PhoneRelayCapability {
  version: 1;
  scope: "phone:connect";
  accountId: string;
  workspaceId: string;
  deviceId: string;
  connectionId: string;
  epoch: string;
  issuedAt: number;
  expiresAt: number;
  sessionExpiresAt: number;
  nonce: string;
}
export interface PhoneRelayStatus {
  state: "stopped" | "connecting" | "connected" | "disconnected";
  workspaceId?: string;
  cloudWorkspaceId?: string;
  deviceId?: string;
  connectionId?: string;
  epoch?: string;
  phoneUrl?: string;
  expiresAt?: number;
  error?: string;
}
export interface PhoneRelayDisconnectRequest { connectionId: string; epoch: string }
export interface PhoneRelayConnectRequest { workspaceId: string; cloudWorkspaceId: string; deviceId: string }
export type PhoneRelayOperation = "begin" | "consent" | "session" | "call" | "disconnect";
export interface PhoneRelayRequest {
  version: 1;
  kind: "request";
  connectionId: string;
  epoch: string;
  revision: number;
  sequence: number;
  requestId: string;
  operation: PhoneRelayOperation;
  browserSession?: string;
  body: unknown;
}
export interface PhoneRelayReply {
  version: 1;
  kind: "reply";
  connectionId: string;
  epoch: string;
  revision: number;
  sequence: number;
  requestId: string;
  status: 200 | 400 | 401 | 403 | 409 | 429 | 503;
  data: unknown;
  session?: { value: string; expiresIn: number };
  clearSession?: true;
}
export interface PhoneRelayHello {
  version: 1;
  kind: "hello";
  connectionId: string;
  epoch: string;
  revision: number;
  expiresAt: number;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
export const PHONE_CONNECTION_ID = /^[a-f0-9]{64}$/;
export const PHONE_CONNECTION_EPOCH = /^[a-f0-9]{32}$/;
const DOMAIN = "mivlet-phone-relay-capability:v1:";
function encode(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid-phone-capability");
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
}
export function validatePhoneRelayCapability(value: unknown): PhoneRelayCapability {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-phone-capability");
  const p = value as PhoneRelayCapability;
  if (Object.keys(p).sort().join(",") !== "accountId,connectionId,deviceId,epoch,expiresAt,issuedAt,nonce,scope,sessionExpiresAt,version,workspaceId"
    || p.version !== 1 || p.scope !== "phone:connect"
    || ![p.accountId, p.workspaceId, p.deviceId, p.nonce].every(v => typeof v === "string" && ID.test(v))
    || !PHONE_CONNECTION_ID.test(p.connectionId) || !PHONE_CONNECTION_EPOCH.test(p.epoch)
    || ![p.issuedAt, p.expiresAt, p.sessionExpiresAt].every(Number.isSafeInteger)
    || p.expiresAt <= p.issuedAt || p.expiresAt > p.issuedAt + PHONE_RELAY_LIMITS.capabilityMs
    || p.sessionExpiresAt < p.expiresAt || p.sessionExpiresAt > p.issuedAt + PHONE_RELAY_LIMITS.sessionMs) {
    throw new Error("invalid-phone-capability");
  }
  return p;
}
async function signingKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("phone-relay-configuration-required");
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(DOMAIN + secret));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, usages);
}
export async function derivePhoneRelayConnectionId(secret: string, scope: Pick<PhoneRelayCapability, "accountId" | "workspaceId" | "deviceId" | "epoch">): Promise<string> {
  if (![scope.accountId, scope.workspaceId, scope.deviceId].every(v => ID.test(v)) || !PHONE_CONNECTION_EPOCH.test(scope.epoch)) throw new Error("invalid-phone-scope");
  const signature = await crypto.subtle.sign("HMAC", await signingKey(secret, ["sign"]), new TextEncoder().encode(JSON.stringify(["connection", scope.accountId, scope.workspaceId, scope.deviceId, scope.epoch])));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function signPhoneRelayCapability(secret: string, payload: PhoneRelayCapability): Promise<string> {
  // Explicit property order is part of mp1, independent of JSON key order supplied by a caller.
  const p = validatePhoneRelayCapability(payload);
  const ordered = Object.fromEntries(Object.keys(p).sort().map(key => [key, p[key as keyof PhoneRelayCapability]]));
  const body = encode(new TextEncoder().encode(JSON.stringify(ordered)));
  const signature = await crypto.subtle.sign("HMAC", await signingKey(secret, ["sign"]), new TextEncoder().encode(body));
  return `mp1.${body}.${encode(new Uint8Array(signature))}`;
}
export async function readPhoneRelayCapability(secret: string, token: string, now = Date.now()): Promise<PhoneRelayCapability> {
  const parts = token.split(".");
  if (token.length > 4_096 || parts.length !== 3 || parts[0] !== "mp1") throw new Error("invalid-phone-capability");
  const signature = Uint8Array.from(decode(parts[2])).buffer;
  if (!await crypto.subtle.verify("HMAC", await signingKey(secret, ["verify"]), signature, new TextEncoder().encode(parts[1]))) {
    throw new Error("invalid-phone-capability");
  }
  const p = validatePhoneRelayCapability(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode(parts[1]))));
  if (p.issuedAt > now + 5_000 || p.expiresAt <= now || p.sessionExpiresAt <= now) throw new Error("phone-capability-expired");
  return p;
}

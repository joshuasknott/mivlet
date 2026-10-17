import { canonicalHostedTaskJson, HOSTED_TEXT_TASK_LIMITS, type HostedTaskCapability } from "./hosted-tasks.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const SCOPES = new Set(["task:admit", "task:read", "task:cancel", "task:input", "task:output", "credential:enroll", "credential:read", "credential:revoke"]);
const DOMAIN = "mivlet-hosted-text-task-capability:v1:";
function bytes(value: Uint8Array): ArrayBuffer { return Uint8Array.from(value).buffer; }
function encode(value: Uint8Array): string { return btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid-task-capability");
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
}
export function validateHostedTaskCapability(value: unknown): HostedTaskCapability {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-task-capability");
  const p = value as HostedTaskCapability;
  if (Object.keys(p).sort().join(",") !== "accountId,agentId,deviceId,expiresAt,issuedAt,nonce,requestSha256,resourceId,scope,version,workspaceId"
    || p.version !== 1 || ![p.accountId, p.workspaceId, p.agentId, p.deviceId, p.resourceId, p.nonce].every(v => typeof v === "string" && ID.test(v))
    || !SCOPES.has(p.scope) || typeof p.requestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(p.requestSha256)
    || !Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.expiresAt) || p.expiresAt <= p.issuedAt
    || p.expiresAt - p.issuedAt > HOSTED_TEXT_TASK_LIMITS.capabilityMs) throw new Error("invalid-task-capability");
  return p;
}
async function key(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("task-signing-configuration-required");
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(DOMAIN + secret));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, usages);
}
export async function signHostedTaskCapability(secret: string, payload: HostedTaskCapability): Promise<string> {
  const body = encode(new TextEncoder().encode(canonicalHostedTaskJson(validateHostedTaskCapability(payload))));
  const signature = await crypto.subtle.sign("HMAC", await key(secret, ["sign"]), new TextEncoder().encode(body));
  return `mt1.${body}.${encode(new Uint8Array(signature))}`;
}
export async function readHostedTaskCapability(secret: string, token: string, now = Date.now()): Promise<HostedTaskCapability> {
  if (token.length > 4096) throw new Error("invalid-task-capability");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "mt1") throw new Error("invalid-task-capability");
  if (!await crypto.subtle.verify("HMAC", await key(secret, ["verify"]), bytes(decode(parts[2])), new TextEncoder().encode(parts[1]))) throw new Error("invalid-task-capability");
  const payload = validateHostedTaskCapability(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode(parts[1]))));
  if (payload.issuedAt > now + 5000 || payload.expiresAt <= now) throw new Error("task-capability-expired");
  return payload;
}

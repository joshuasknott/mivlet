import { PHONE_RELAY_LIMITS, type PhoneRelayReply } from "@mivlet/protocol";

export interface PhoneEnv extends PhoneRelayBindings {
  MIVLET_PHONE_RELAY_SIGNING_KEY: string;
}
export const SESSION = /^[A-Za-z0-9_-]{43}$/;
export const OPERATIONS = new Set(["begin", "consent", "session", "call", "disconnect", "push-status", "push-subscribe"]);
export function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const result = new Headers(headers);
  result.set("Cache-Control", "no-store");
  result.set("Content-Type", "application/json");
  result.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(value), { status, headers: result });
}
export async function body(request: Request): Promise<unknown> {
  if (request.headers.get("Content-Type") !== "application/json") throw new Error("invalid-body");
  if (Number(request.headers.get("Content-Length")) > PHONE_RELAY_LIMITS.bodyBytes) throw new Error("body-too-large");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid-body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > PHONE_RELAY_LIMITS.bodyBytes) { await reader.cancel(); throw new Error("body-too-large"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export function cookieName(connectionId: string): string { return `__Host-mivlet-phone-${connectionId}`; }
export function browserSession(headers: Headers, connectionId: string): string | undefined {
  let value: string | undefined;
  for (const pair of (headers.get("Cookie") ?? "").split(";")) {
    const [name, ...parts] = pair.trim().split("=");
    if (name !== cookieName(connectionId)) continue;
    if (value || parts.length !== 1 || !SESSION.test(parts[0])) throw new Error("invalid-session");
    value = parts[0];
  }
  return value;
}
export function validReply(value: unknown): value is PhoneRelayReply {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as PhoneRelayReply;
  const allowed = ["version", "kind", "connectionId", "epoch", "revision", "sequence", "requestId", "status", "data", "session", "clearSession"];
  return Object.keys(p).every(k => allowed.includes(k)) && p.version === 1 && p.kind === "reply"
    && [200, 400, 401, 403, 409, 429, 503].includes(p.status)
    && typeof p.data === "object" && p.data !== null && new TextEncoder().encode(JSON.stringify(p.data)).length <= PHONE_RELAY_LIMITS.bodyBytes
    && (!p.session || Object.keys(p.session).sort().join(",") === "expiresIn,value" && SESSION.test(p.session.value)
      && Number.isSafeInteger(p.session.expiresIn) && p.session.expiresIn > 0 && p.session.expiresIn <= 8 * 3600)
    && (p.clearSession === undefined || p.clearSession === true) && !(p.session && p.clearSession);
}

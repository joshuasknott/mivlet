import { DurableObject } from "cloudflare:workers";
import { PHONE_RELAY_LIMITS, derivePhoneRelayConnectionId, readPhoneRelayCapability, type PhoneRelayCapability, type PhoneRelayOperation, type PhoneRelayReply, type PhoneRelayRequest } from "@mivlet/protocol";
import { json, OPERATIONS, validReply, type PhoneEnv } from "./contracts";

interface Owner {
  accountId: string; workspaceId: string; deviceId: string; connectionId: string; epoch: string;
  revision: number; sequence: number; authorityExpiresAt: number; sessionExpiresAt: number;
  nonce: string; minute: number; count: number;
  usedNonces: Array<{ nonce: string; expiresAt: number }>;
}
interface Pending {
  revision: number; sequence: number;
  resolve: (reply: PhoneRelayReply | undefined) => void;
}
/** A transport atom only. No task text, browser cookie, native token or reply is stored. */
export class PhoneRelayAuthority extends DurableObject<PhoneEnv> {
  private pending = new Map<string, Pending>();
  private forwarding = 0;

  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== "GET" || request.headers.has("Origin") || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "native-connection-required" }, 403);
      const token = request.headers.get("Authorization")?.match(/^MivletPhone (mp1\.[A-Za-z0-9_.-]+)$/)?.[1];
      if (!token) return json({ error: "unauthorized" }, 401);
      const cap = await readPhoneRelayCapability(this.env.MIVLET_PHONE_RELAY_SIGNING_KEY, token);
      if (new URL(request.url).pathname !== `/v1/phone/${cap.connectionId}/connect`
        || await derivePhoneRelayConnectionId(this.env.MIVLET_PHONE_RELAY_SIGNING_KEY, cap) !== cap.connectionId) return json({ error: "scope-mismatch" }, 401);
      return await this.connectNative(cap);
    } catch { return json({ error: "phone-connection-rejected" }, 401); }
  }

  private async connectNative(cap: PhoneRelayCapability): Promise<Response> {
    const now = Date.now();
    const owner = await this.ctx.storage.transaction(async tx => {
      const previous = await tx.get<Owner>("owner");
      if (previous && (previous.accountId !== cap.accountId || previous.workspaceId !== cap.workspaceId
        || previous.deviceId !== cap.deviceId || previous.epoch !== cap.epoch || previous.usedNonces.some(p => p.nonce === cap.nonce))) throw new Error("stale-connection");
      if (cap.expiresAt <= now) throw new Error("expired-connection");
      const next: Owner = { accountId: cap.accountId, workspaceId: cap.workspaceId, deviceId: cap.deviceId,
        connectionId: cap.connectionId, epoch: cap.epoch, revision: (previous?.revision ?? 0) + 1,
        sequence: 0, authorityExpiresAt: cap.expiresAt, sessionExpiresAt: Math.min(previous?.sessionExpiresAt ?? cap.sessionExpiresAt, cap.sessionExpiresAt),
        nonce: cap.nonce, minute: Math.floor(now / 60_000), count: 0,
        usedNonces: [...(previous?.usedNonces ?? []).filter(p => p.expiresAt > now), { nonce: cap.nonce, expiresAt: cap.expiresAt }] };
      if (next.usedNonces.length > 8) throw new Error("renewal-rate-limited");
      if (next.sessionExpiresAt <= now) throw new Error("expired-connection");
      await tx.put("owner", next);
      await tx.setAlarm(Math.min(next.authorityExpiresAt, next.sessionExpiresAt));
      return next;
    });
    for (const socket of this.ctx.getWebSockets()) socket.close(4001, "Connection replaced");
    this.failPending();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ connectionId: owner.connectionId, epoch: owner.epoch, revision: owner.revision });
    server.send(JSON.stringify({ version: 1, kind: "hello", connectionId: owner.connectionId, epoch: owner.epoch,
      revision: owner.revision, expiresAt: owner.authorityExpiresAt }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async forward(connectionId: string, operation: PhoneRelayOperation, browserSession: string | undefined, body: unknown): Promise<Response> {
    if (!OPERATIONS.has(operation) || this.forwarding >= PHONE_RELAY_LIMITS.inFlight) return json({ error: "relay-busy" }, 429);
    this.forwarding += 1;
    try { return await this.forwardOne(connectionId, operation, browserSession, body); }
    finally { this.forwarding -= 1; }
  }
  private async forwardOne(connectionId: string, operation: PhoneRelayOperation, browserSession: string | undefined, body: unknown): Promise<Response> {
    if (new TextEncoder().encode(JSON.stringify(body)).length > PHONE_RELAY_LIMITS.bodyBytes) return json({ error: "Request too large." }, 400);
    const owner = await this.ctx.storage.transaction(async tx => {
      const current = await tx.get<Owner>("owner");
      const now = Date.now();
      if (!current || current.connectionId !== connectionId || Math.min(current.authorityExpiresAt, current.sessionExpiresAt) <= now) return undefined;
      const minute = Math.floor(now / 60_000);
      current.count = current.minute === minute ? current.count + 1 : 1;
      current.minute = minute;
      if (current.count > PHONE_RELAY_LIMITS.requestsPerMinute) return undefined;
      current.sequence += 1;
      await tx.put("owner", current);
      return current;
    });
    const socket = this.ctx.getWebSockets().find(ws => {
      const a = ws.deserializeAttachment() as Partial<Owner> | null;
      return a?.connectionId === connectionId && a.epoch === owner?.epoch && a.revision === owner?.revision;
    });
    if (!owner || !socket) return json({ error: "Your computer is unavailable. Keep Mivlet open and signed in." }, 503);
    const requestId = crypto.randomUUID();
    const frame: PhoneRelayRequest = { version: 1, kind: "request", connectionId, epoch: owner.epoch,
      revision: owner.revision, sequence: owner.sequence, requestId, operation, ...(browserSession ? { browserSession } : {}), body };
    const encoded = JSON.stringify(frame);
    if (new TextEncoder().encode(encoded).length > PHONE_RELAY_LIMITS.frameBytes) return json({ error: "Request too large." }, 400);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const reply = await new Promise<PhoneRelayReply | undefined>(resolve => {
      this.pending.set(requestId, { revision: owner.revision, sequence: owner.sequence, resolve });
      timeout = setTimeout(() => { this.pending.delete(requestId); resolve(undefined); }, PHONE_RELAY_LIMITS.requestMs);
      try { socket.send(encoded); } catch { this.pending.delete(requestId); resolve(undefined); }
    });
    if (timeout) clearTimeout(timeout);
    if (!reply) return json({ error: "Connection lost before confirmation. The request may have reached Mivlet." }, 503);
    const latest = await this.ctx.storage.get<Owner>("owner");
    if (!latest || latest.revision !== owner.revision || Math.min(latest.authorityExpiresAt, latest.sessionExpiresAt) <= Date.now()) {
      return json({ error: "Connection changed before confirmation. Check the saved task state." }, 503);
    }
    // Only fixed JSON/cookie semantics cross the shared origin. Native cannot supply HTML or headers.
    const headers = new Headers();
    const name = `__Host-mivlet-phone-${connectionId}`;
    if (reply.session) headers.set("Set-Cookie", `${name}=${reply.session.value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.min(reply.session.expiresIn, Math.max(0, Math.floor((owner.sessionExpiresAt - Date.now()) / 1000)))}`);
    if (reply.clearSession) headers.set("Set-Cookie", `${name}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
    return json(reply.data, reply.status, headers);
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || new TextEncoder().encode(raw).length > PHONE_RELAY_LIMITS.frameBytes) { socket.close(4002, "Invalid message"); return; }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { socket.close(4002, "Invalid message"); return; }
    const a = socket.deserializeAttachment() as Partial<Owner> | null;
    const owner = await this.ctx.storage.get<Owner>("owner");
    if (!owner || a?.revision !== owner.revision || a.epoch !== owner.epoch || a.connectionId !== owner.connectionId
      || Math.min(owner.authorityExpiresAt, owner.sessionExpiresAt) <= Date.now()) { socket.close(4001, "Connection expired"); this.failPending(a?.revision); return; }
    if (value && typeof value === "object" && !Array.isArray(value) && (value as { kind?: string }).kind === "renew") {
      await this.renew(socket, value as Record<string, unknown>, owner);
      return;
    }
    if (!validReply(value) || value.connectionId !== owner.connectionId || value.epoch !== owner.epoch || value.revision !== owner.revision) {
      socket.close(4002, "Invalid reply"); this.failPending(owner.revision); return;
    }
    const pending = this.pending.get(value.requestId);
    if (!pending) return; // A late response cannot resurrect an expired HTTP request.
    if (pending.revision !== value.revision || pending.sequence !== value.sequence) { socket.close(4002, "Reply mismatch"); this.failPending(owner.revision); return; }
    this.pending.delete(value.requestId);
    pending.resolve(value);
  }

  private async renew(socket: WebSocket, value: Record<string, unknown>, owner: Owner): Promise<void> {
    try {
      if (Object.keys(value).sort().join(",") !== "kind,token,version" || value.version !== 1 || typeof value.token !== "string") throw new Error("invalid-renewal");
      const cap = await readPhoneRelayCapability(this.env.MIVLET_PHONE_RELAY_SIGNING_KEY, value.token);
      if (cap.accountId !== owner.accountId || cap.workspaceId !== owner.workspaceId || cap.deviceId !== owner.deviceId
        || cap.connectionId !== owner.connectionId || cap.epoch !== owner.epoch) throw new Error("invalid-renewal");
      const renewed = await this.ctx.storage.transaction(async tx => {
        const current = await tx.get<Owner>("owner");
        if (!current || current.revision !== owner.revision || current.usedNonces.some(p => p.nonce === cap.nonce)
          || cap.expiresAt <= current.authorityExpiresAt || Math.min(current.authorityExpiresAt, current.sessionExpiresAt) <= Date.now()) throw new Error("expired-renewal");
        current.usedNonces = [...current.usedNonces.filter(p => p.expiresAt > Date.now()), { nonce: cap.nonce, expiresAt: cap.expiresAt }];
        if (current.usedNonces.length > 8) throw new Error("renewal-rate-limited");
        current.nonce = cap.nonce;
        current.authorityExpiresAt = cap.expiresAt;
        await tx.put("owner", current);
        await tx.setAlarm(Math.min(current.authorityExpiresAt, current.sessionExpiresAt));
        return current;
      });
      socket.send(JSON.stringify({ version: 1, kind: "renewed", connectionId: owner.connectionId, epoch: owner.epoch,
        revision: owner.revision, expiresAt: renewed.authorityExpiresAt }));
    } catch { socket.close(4001, "Renewal rejected"); this.failPending(owner.revision); }
  }
  private failPending(revision?: number): void {
    for (const [id, pending] of this.pending) {
      if (revision !== undefined && pending.revision !== revision) continue;
      pending.resolve(undefined); this.pending.delete(id);
    }
  }
  async webSocketClose(socket: WebSocket): Promise<void> { socket.close(1000, "Closed"); await this.closed(socket); }
  async webSocketError(socket: WebSocket): Promise<void> { socket.close(1011, "Connection lost"); await this.closed(socket); }
  private async closed(socket: WebSocket): Promise<void> {
    const a = socket.deserializeAttachment() as Partial<Owner> | null;
    const current = await this.ctx.storage.get<Owner>("owner");
    if (current && a?.revision === current.revision && a.epoch === current.epoch) this.failPending(current.revision);
  }
  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const owner = await this.ctx.storage.get<Owner>("owner");
      if (owner && Math.min(owner.authorityExpiresAt, owner.sessionExpiresAt) > Date.now()) {
        await this.ctx.storage.setAlarm(Math.min(owner.authorityExpiresAt, owner.sessionExpiresAt)); return;
      }
      for (const socket of this.ctx.getWebSockets()) socket.close(4001, "Connection expired");
      this.failPending();
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
    });
  }
}

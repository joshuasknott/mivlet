import { afterEach, describe, expect, it, vi } from "vitest";
import { derivePhoneRelayConnectionId, readPhoneRelayCapability, signPhoneRelayCapability, type PhoneRelayCapability } from "@mivlet/protocol";
import { PhoneRelayAuthority } from "./authority";
import { browserSession, cookieName, validReply, type PhoneEnv } from "./contracts";

const secret = "phone-deployment-secret-for-fixtures-only-0123456789";
const id = "a".repeat(64), epoch = "b".repeat(32), opaque = "c".repeat(43);
class Memory {
  values = new Map<string, unknown>();
  alarm: number | undefined;
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async put(key: string, value: unknown) { this.values.set(key, structuredClone(value)); }
  async transaction<T>(fn: (tx: Memory) => Promise<T>) { return fn(this); }
  async setAlarm(value: number) { this.alarm = value; }
  async deleteAlarm() { this.alarm = undefined; }
  async deleteAll() { this.values.clear(); }
}
function fixture() {
  const memory = new Memory();
  const owner = { accountId: "account-one", workspaceId: "workspace-one", deviceId: "device-one", connectionId: id, epoch,
    revision: 1, sequence: 0, authorityExpiresAt: Date.now() + 120000, sessionExpiresAt: Date.now() + 28800000,
    nonce: "nonce-fixture", usedNonces: [{ nonce: "nonce-fixture", expiresAt: Date.now() + 120000 }], minute: Math.floor(Date.now() / 60000), count: 0 };
  memory.values.set("owner", owner);
  const socket = { send: vi.fn(), close: vi.fn(), deserializeAttachment: () => ({ connectionId: id, epoch, revision: 1 }) };
  const ctx = { storage: memory, getWebSockets: () => [socket], blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn() } as unknown as DurableObjectState;
  const authority = new PhoneRelayAuthority(ctx, { MIVLET_PHONE_RELAY_SIGNING_KEY: secret } as PhoneEnv);
  return { memory, socket, authority, owner };
}
function reply(request: Record<string, unknown>, data: unknown = { ok: true }) {
  return { version: 1, kind: "reply", connectionId: request.connectionId, epoch: request.epoch, revision: request.revision,
    sequence: request.sequence, requestId: request.requestId, status: 200, data };
}
afterEach(() => vi.useRealTimers());
describe("managed phone capability", () => {
  it("binds the public namespace to the authenticated account, workspace, device and native epoch", async () => {
    const scope = { accountId: "account-one", workspaceId: "workspace-one", deviceId: "device-one", epoch };
    const first = await derivePhoneRelayConnectionId(secret, scope);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(await derivePhoneRelayConnectionId(secret, scope)).toBe(first);
    for (const change of [{ accountId: "account-two" }, { workspaceId: "workspace-two" }, { deviceId: "device-two" }, { epoch: "d".repeat(32) }]) {
      expect(await derivePhoneRelayConnectionId(secret, { ...scope, ...change })).not.toBe(first);
    }
    const now = Date.now();
    const cap: PhoneRelayCapability = { version: 1, scope: "phone:connect", ...scope, connectionId: first, issuedAt: now,
      expiresAt: now + 120000, sessionExpiresAt: now + 28800000, nonce: "nonce-signature" };
    const token = await signPhoneRelayCapability(secret, cap);
    expect(await readPhoneRelayCapability(secret, token)).toEqual(cap);
    await expect(readPhoneRelayCapability(secret, token, cap.expiresAt)).rejects.toThrow();
    await expect(readPhoneRelayCapability(`${secret}-other`, token)).rejects.toThrow();
    await expect(signPhoneRelayCapability(secret, { ...cap, expiresAt: now + 120001 })).rejects.toThrow();
    await expect(signPhoneRelayCapability(secret, { ...cap, connectionId: [first] } as unknown as PhoneRelayCapability)).rejects.toThrow();
    await expect(signPhoneRelayCapability(secret, { ...cap, epoch: [epoch] } as unknown as PhoneRelayCapability)).rejects.toThrow();
  });
});
describe("closed relay transport", () => {
  it("returns JSON only with exact ownership and sequence, without storing content or browser credentials", async () => {
    const f = fixture();
    f.socket.send.mockImplementation((text: string) => {
      const request = JSON.parse(text);
      expect(request.browserSession).toBe(opaque);
      void f.authority.webSocketMessage(f.socket as unknown as WebSocket, JSON.stringify(reply(request, { text: "PRIVATE_RESULT_CANARY" })));
    });
    const response = await f.authority.forward(id, "call", opaque, { name: "mivlet_request_task", arguments: { text: "PRIVATE_TASK_CANARY", requestId: "original-write-id" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "PRIVATE_RESULT_CANARY" });
    expect(JSON.parse(f.socket.send.mock.calls[0][0]).sequence).toBe(1);
    const saved = JSON.stringify([...f.memory.values]);
    expect(saved).not.toContain("PRIVATE_");
    expect(saved).not.toContain(opaque);
    expect(saved).not.toContain("original-write-id");
  });
  it("fails unknown delivery without replay and ignores a late response", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const result = f.authority.forward(id, "call", opaque, { name: "mivlet_stop_work", arguments: { requestId: "same-explicit-id" } });
    await vi.advanceTimersByTimeAsync(10001);
    expect((await result).status).toBe(503);
    expect(f.socket.send).toHaveBeenCalledTimes(1);
    const request = JSON.parse(f.socket.send.mock.calls[0][0]);
    await f.authority.webSocketMessage(f.socket as unknown as WebSocket, JSON.stringify(reply(request)));
    expect(f.memory.values.size).toBe(1);
  });
  it("rejects stale sequence, another epoch, oversized replies and arbitrary response headers", async () => {
    const f = fixture();
    f.socket.send.mockImplementation((text: string) => {
      const request = JSON.parse(text);
      void f.authority.webSocketMessage(f.socket as unknown as WebSocket, JSON.stringify({ ...reply(request), epoch: "e".repeat(32) }));
    });
    expect((await f.authority.forward(id, "session", opaque, {})).status).toBe(503);
    expect(f.socket.close).toHaveBeenCalled();
    const base = reply({ connectionId: id, epoch, revision: 1, sequence: 1, requestId: "request-one" });
    expect(validReply({ ...base, headers: { "Content-Type": "text/html" } })).toBe(false);
    expect(validReply({ ...base, data: { text: "x".repeat(65536) } })).toBe(false);
    expect(validReply({ ...base, session: { value: "cookie; Domain=example", expiresIn: 60 } })).toBe(false);
  });
  it("expires once and removes the complete storage metadata", async () => {
    const f = fixture();
    f.memory.values.set("owner", { ...f.owner, authorityExpiresAt: Date.now() - 1 });
    await f.authority.alarm();
    expect(f.memory.values.size).toBe(0);
    expect(f.memory.alarm).toBeUndefined();
    expect((await f.authority.forward(id, "session", opaque, {})).status).toBe(503);
    await f.authority.alarm();
    expect(f.memory.values.size).toBe(0);
  });
  it("accepts renewed identity only for the same connection and consumes each nonce once", async () => {
    const f = fixture();
    const now = Date.now();
    f.memory.values.set("owner", { ...f.owner, authorityExpiresAt: now + 60000 });
    const cap: PhoneRelayCapability = { version: 1, scope: "phone:connect", accountId: f.owner.accountId, workspaceId: f.owner.workspaceId,
      deviceId: f.owner.deviceId, connectionId: id, epoch, issuedAt: now, expiresAt: now + 120000, sessionExpiresAt: now + 28800000, nonce: "nonce-new" };
    const token = await signPhoneRelayCapability(secret, cap);
    await f.authority.webSocketMessage(f.socket as unknown as WebSocket, JSON.stringify({ version: 1, kind: "renew", token }));
    expect(JSON.parse(f.socket.send.mock.calls[0][0]).kind).toBe("renewed");
    await f.authority.webSocketMessage(f.socket as unknown as WebSocket, JSON.stringify({ version: 1, kind: "renew", token }));
    expect(f.socket.close).toHaveBeenCalledWith(4001, "Renewal rejected");
  });
  it("accepts only the exact connection cookie, rejecting duplicates", () => {
    expect(browserSession(new Headers({ Cookie: `${cookieName(id)}=${opaque}` }), id)).toBe(opaque);
    expect(browserSession(new Headers({ Cookie: `${cookieName("d".repeat(64))}=${opaque}` }), id)).toBeUndefined();
    expect(() => browserSession(new Headers({ Cookie: `${cookieName(id)}=${opaque}; ${cookieName(id)}=${opaque}` }), id)).toThrow();
  });
});

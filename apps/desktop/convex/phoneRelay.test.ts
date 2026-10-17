// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { derivePhoneRelayConnectionId, readPhoneRelayCapability, readHostedTaskCapability } from "@mivlet/protocol";
import { api, internal } from "./_generated/api";
import {
  authorizePhoneRelayCapability, mintPhoneRelayCapability, parsePhoneRelayCapabilityArgs,
  requestPhoneRelayCapability, type PhoneRelayCapabilityArgs,
} from "./phoneRelay";
import { handleNativePhoneRelayCapability } from "./http";

const args: PhoneRelayCapabilityArgs = { workspaceId: "workspace_unit", deviceId: "device_unit", epoch: "a".repeat(32) };
const identity = { issuer: "https://clerk.example", subject: "clerk_user" };
const auth = { getUserIdentity: async () => identity };
const key = "unit-phone-key-not-a-real-deployment-secret";
afterEach(() => vi.unstubAllEnvs());

describe("native phone relay issuer", () => {
  it("keeps capability functions internal and derives the public route from server identity", async () => {
    expect(requestPhoneRelayCapability.isInternal).toBe(true);
    expect(authorizePhoneRelayCapability.isInternal).toBe(true);
    // @ts-expect-error native transport authority is not a public renderer query
    void api.phoneRelay.requestPhoneRelayCapability;
    vi.stubEnv("MIVLET_PHONE_RELAY_SIGNING_KEY", key);
    vi.stubEnv("MIVLET_PHONE_RELAY_URL", "https://phone.example.com");
    const runQuery = vi.fn(async () => ({ accountId: "account_unit" }));
    const receipt = await mintPhoneRelayCapability({ auth, runQuery }, args);
    const cap = await readPhoneRelayCapability(key, receipt.token);
    expect(cap).toMatchObject({ ...args, accountId: "account_unit", scope: "phone:connect", version: 1 });
    expect(cap.expiresAt - cap.issuedAt).toBe(120_000);
    expect(cap.sessionExpiresAt - cap.issuedAt).toBe(8 * 60 * 60_000);
    expect(receipt.sessionExpiresAt).toBe(cap.sessionExpiresAt);
    expect(receipt.relayUrl).toBe("https://phone.example.com");
    expect(receipt.connectionId).toBe(await derivePhoneRelayConnectionId(key, { accountId: "account_unit", ...args }));
    const repeated = await mintPhoneRelayCapability({ auth, runQuery }, args);
    expect(repeated.connectionId).toBe(receipt.connectionId);
    expect((await readPhoneRelayCapability(key, repeated.token)).nonce).not.toBe(cap.nonce);
    for (const scope of [
      { accountId: "account_other", ...args },
      { accountId: "account_unit", ...args, deviceId: "device_other" },
      { accountId: "account_unit", ...args, workspaceId: "workspace_other" },
      { accountId: "account_unit", ...args, epoch: "b".repeat(32) },
    ]) expect(await derivePhoneRelayConnectionId(key, scope)).not.toBe(receipt.connectionId);
    await expect(readHostedTaskCapability(key, receipt.token)).rejects.toThrow();
  });
  it("rejects authority supplied by the caller, raw session data and malformed epochs", () => {
    expect(parsePhoneRelayCapabilityArgs(args)).toEqual(args);
    for (const bad of [
      { ...args, connectionId: "a".repeat(64) }, { ...args, accountId: "account_other" },
      { ...args, token: "private" }, { ...args, epoch: "A".repeat(32) },
      { ...args, epoch: "a".repeat(33) }, { ...args, workspaceId: "../workspace" },
    ]) expect(() => parsePhoneRelayCapabilityArgs(bad)).toThrow("invalid-request");
  });
  it("requires identity and separate deployment configuration", async () => {
    const runQuery = vi.fn(async () => ({ accountId: "account_unit" }));
    await expect(mintPhoneRelayCapability({ auth: { getUserIdentity: async () => null }, runQuery }, args)).rejects.toThrow("authentication-required");
    expect(runQuery).not.toHaveBeenCalled();
    vi.stubEnv("MIVLET_PHONE_RELAY_SIGNING_KEY", ""); vi.stubEnv("FABLE_PHONE_RELAY_SIGNING_KEY", "");
    vi.stubEnv("MIVLET_HOSTED_TASK_SIGNING_KEY", key);
    await expect(mintPhoneRelayCapability({ auth, runQuery }, args)).rejects.toThrow("runner-configuration-required");
  });
});

type Row = Record<string, unknown>;
function membership() {
  const tables: Record<string, Row[]> = {
    external_identity_links: [{ provider: "clerk", normalizedIssuer: identity.issuer, subject: identity.subject, internalUserId: "account_unit", status: "active" }],
    internal_users: [{ internalUserId: "account_unit", status: "active" }],
    workspaces: [{ workspaceId: args.workspaceId, status: "active" }],
    workspace_memberships: [{ workspaceId: args.workspaceId, internalUserId: "account_unit", memberId: "member_unit", role: "viewer", status: "active" }],
    account_devices: [{ deviceId: args.deviceId, internalUserId: "account_unit", status: "active" }],
    workspace_device_links: [{ workspaceId: args.workspaceId, deviceId: args.deviceId, internalUserId: "account_unit", memberId: "member_unit", status: "active" }],
  };
  const ctx = { auth, db: { query(table: string) {
    const filters: Array<[string, unknown]> = [];
    const q = { eq(field: string, value: unknown) { filters.push([field, value]); return q; } };
    return { withIndex(_name: string, select: (query: typeof q) => unknown) {
      select(q);
      return { collect: async () => (tables[table] ?? []).filter(row => filters.every(([field, value]) => row[field] === value)) };
    } };
  } } };
  const authorize = () => (authorizePhoneRelayCapability as unknown as {
    _handler: (context: typeof ctx, value: { workspaceId: string; deviceId: string }) => Promise<{ accountId: string }>;
  })._handler(ctx, { workspaceId: args.workspaceId, deviceId: args.deviceId });
  return { tables, authorize };
}

describe("phone relay account boundary", () => {
  it("allows an active read-only member to connect transport without granting task-write authority", async () => {
    await expect(membership().authorize()).resolves.toEqual({ accountId: "account_unit" });
  });
  it.each([
    ["workspace_memberships", "status", "suspended"], ["workspaces", "status", "locked"],
    ["internal_users", "status", "disabled"], ["account_devices", "status", "revoked"],
    ["account_devices", "internalUserId", "account_other"], ["workspace_device_links", "memberId", "member_other"],
  ])("rejects a changed %s %s", async (table, field, value) => {
    const f = membership(); f.tables[table][0][field] = value;
    await expect(f.authorize()).rejects.toThrow();
  });
});

describe("phone relay HTTP boundary", () => {
  const request = (body: unknown = args, headers: Record<string, string> = {}) => new Request("https://deployment.convex.site/native/phone-relay-capability", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const context = () => ({ auth, runMutation: vi.fn(async () => undefined), runAction: vi.fn(async () => ({ token: "fixture-token" })) });
  it("shares the device mint budget before invoking the distinct phone action", async () => {
    const ctx = context(); const response = await handleNativePhoneRelayCapability(ctx, request());
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(ctx.runMutation).toHaveBeenCalledWith(internal.hostedExecution.consumeExecutionCapabilityMint, { deviceId: args.deviceId });
    expect(ctx.runAction).toHaveBeenCalledWith(internal.phoneRelay.requestPhoneRelayCapability, args);
    expect(ctx.runMutation.mock.invocationCallOrder[0]).toBeLessThan(ctx.runAction.mock.invocationCallOrder[0]);
  });
  it("rejects browser origins, missing identity and oversized bodies without minting", async () => {
    const ctx = context();
    expect((await handleNativePhoneRelayCapability(ctx, request(args, { origin: "https://phone.example.com" }))).status).toBe(403);
    expect((await handleNativePhoneRelayCapability({ ...ctx, auth: { getUserIdentity: async () => null } }, request())).status).toBe(401);
    expect((await handleNativePhoneRelayCapability(ctx, request("x".repeat(2049)))).status).toBe(400);
    expect(ctx.runMutation).not.toHaveBeenCalled(); expect(ctx.runAction).not.toHaveBeenCalled();
  });
  it("never mints after the shared rate limit refuses the request", async () => {
    const ctx = context(); ctx.runMutation.mockRejectedValueOnce(new Error("rate-limited"));
    const response = await handleNativePhoneRelayCapability(ctx, request());
    expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("60");
    expect(ctx.runAction).not.toHaveBeenCalled();
  });
});

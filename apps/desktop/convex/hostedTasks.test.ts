// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { readHostedTaskCapability } from "@mivlet/protocol";
import { api, internal } from "./_generated/api";
import {
  authorizeHostedTaskCapability, mintHostedTaskCapability, parseHostedTaskCapabilityArgs,
  requestHostedTaskCapability, type HostedTaskCapabilityArgs,
} from "./hostedTasks";
import { handleNativeHostedTaskCapability } from "./http";

const args: HostedTaskCapabilityArgs = {
  workspaceId: "workspace_unit", deviceId: "device_unit", agentId: "agent_unit",
  scope: "task:admit", resourceId: "task_unit", requestSha256: "a".repeat(64),
};
const identity = { issuer: "https://clerk.example", subject: "clerk_user" };
const auth = { getUserIdentity: async () => identity };
const key = "unit-task-key-not-a-real-deployment-secret";
afterEach(() => vi.unstubAllEnvs());

describe("hosted text capability authority", () => {
  it("keeps the mint and authorization functions internal", () => {
    expect(requestHostedTaskCapability.isInternal).toBe(true);
    expect(requestHostedTaskCapability.isAction).toBe(true);
    expect(authorizeHostedTaskCapability.isInternal).toBe(true);
    expect(authorizeHostedTaskCapability.isQuery).toBe(true);
    void internal.hostedTasks.requestHostedTaskCapability;
    // @ts-expect-error a renderer Convex client cannot obtain the task capability
    void api.hostedTasks.requestHostedTaskCapability;
  });

  it("signs the exact body digest for the server-derived account and short lifetime", async () => {
    vi.stubEnv("MIVLET_HOSTED_TASK_SIGNING_KEY", key);
    vi.stubEnv("MIVLET_HOSTED_TASK_URL", "https://tasks.example.com");
    const runQuery = vi.fn(async () => ({ accountId: "account_unit" }));
    const receipt = await mintHostedTaskCapability({ auth, runQuery }, args);
    expect(runQuery).toHaveBeenCalledWith(internal.hostedTasks.authorizeHostedTaskCapability,
      { workspaceId: args.workspaceId, deviceId: args.deviceId, agentId: args.agentId });
    const cap = await readHostedTaskCapability(key, receipt.token);
    expect(cap).toMatchObject({ ...args, accountId: "account_unit", version: 1 });
    expect(cap.expiresAt - cap.issuedAt).toBe(120_000);
    expect(receipt.runnerUrl).toBe("https://tasks.example.com");
    expect(Object.keys(receipt).sort()).toEqual(["expiresAt", "runnerUrl", "token"]);
    await expect(readHostedTaskCapability("different-test-material-longer-than32", receipt.token)).rejects.toThrow();
  });

  it("refuses missing identity before authorization and missing task configuration after it", async () => {
    const runQuery = vi.fn(async () => ({ accountId: "account_unit" }));
    await expect(mintHostedTaskCapability({ auth: { getUserIdentity: async () => null }, runQuery }, args))
      .rejects.toThrow("authentication-required");
    expect(runQuery).not.toHaveBeenCalled();
    vi.stubEnv("MIVLET_HOSTED_TASK_SIGNING_KEY", "");
    vi.stubEnv("FABLE_HOSTED_TASK_SIGNING_KEY", "");
    vi.stubEnv("MIVLET_HOSTED_RUNNER_SIGNING_KEY", key);
    await expect(mintHostedTaskCapability({ auth, runQuery }, args)).rejects.toThrow("runner-configuration-required");
  });

  it("accepts only bounded exact task scope arguments and rejects secret or text additions", () => {
    expect(parseHostedTaskCapabilityArgs(args)).toEqual(args);
    for (const bad of [
      { ...args, accountId: "account_attacker" }, { ...args, secret: "do-not-accept" },
      { ...args, input: "private task text" }, { ...args, scope: "process:launch" },
      { ...args, requestSha256: "A".repeat(64) }, { ...args, agentId: "x".repeat(161) },
      { ...args, resourceId: "../task_unit" }, { ...args, scope: "credential:read" },
    ]) expect(() => parseHostedTaskCapabilityArgs(bad)).toThrow("invalid-request");
    expect(parseHostedTaskCapabilityArgs({ ...args, scope: "credential:read", resourceId: "connections" }).scope)
      .toBe("credential:read");
  });
});

type Row = Record<string, unknown>;
function authorizedContext() {
  const tables: Record<string, Row[]> = {
    external_identity_links: [{ provider: "clerk", normalizedIssuer: identity.issuer, subject: identity.subject, internalUserId: "account_unit", status: "active" }],
    internal_users: [{ internalUserId: "account_unit", status: "active" }],
    workspaces: [{ workspaceId: args.workspaceId, status: "active" }],
    workspace_memberships: [{ workspaceId: args.workspaceId, internalUserId: "account_unit", memberId: "member_unit", role: "editor", status: "active" }],
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
  const authorize = () => (authorizeHostedTaskCapability as unknown as {
    _handler: (context: typeof ctx, value: { workspaceId: string; deviceId: string; agentId: string }) => Promise<{ accountId: string }>;
  })._handler(ctx, { workspaceId: args.workspaceId, deviceId: args.deviceId, agentId: args.agentId });
  return { tables, authorize };
}

describe("hosted text account and device binding", () => {
  it("uses active membership without requiring a hosted computer", async () => {
    const f = authorizedContext();
    await expect(f.authorize()).resolves.toEqual({ accountId: "account_unit" });
    expect(f.tables.hosted_execution_nodes).toBeUndefined();
  });
  it.each([
    ["workspace_memberships", "role", "viewer"],
    ["workspace_memberships", "status", "suspended"],
    ["workspaces", "status", "locked"],
    ["internal_users", "status", "disabled"],
    ["account_devices", "status", "revoked"],
    ["account_devices", "internalUserId", "account_other"],
    ["workspace_device_links", "memberId", "member_other"],
  ])("rejects an unauthorized %s %s", async (table, field, value) => {
    const f = authorizedContext(); f.tables[table][0][field] = value;
    await expect(f.authorize()).rejects.toThrow();
  });
  it("fails closed for ambiguous membership records", async () => {
    const f = authorizedContext(); f.tables.workspace_memberships.push({ ...f.tables.workspace_memberships[0] });
    await expect(f.authorize()).rejects.toThrow("Active Mivlet workspace membership is required.");
  });
});

function request(body: unknown = args, headers: Record<string, string> = {}) {
  return new Request("https://deployment.convex.site/native/task-capability", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}
function httpContext() {
  return { auth, runMutation: vi.fn(async () => ({ allowed: true })),
    runAction: vi.fn(async () => ({ runnerUrl: "https://tasks.example.com", token: "unit-token", expiresAt: 1234 })) };
}

describe("native hosted text HTTP gate", () => {
  it("mints only after Clerk and the shared subject/device budget, with an uncacheable reply", async () => {
    const ctx = httpContext(); const result = await handleNativeHostedTaskCapability(ctx, request());
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("access-control-allow-origin")).toBeNull();
    expect(ctx.runMutation).toHaveBeenCalledWith(internal.hostedExecution.consumeExecutionCapabilityMint, { deviceId: args.deviceId });
    expect(ctx.runAction).toHaveBeenCalledWith(internal.hostedTasks.requestHostedTaskCapability, args);
    expect(ctx.runMutation.mock.invocationCallOrder[0]).toBeLessThan(ctx.runAction.mock.invocationCallOrder[0]);
  });
  it.each<Record<string, string>>([{ origin: "null" }, { origin: "https://mivlet.example" }, { "sec-fetch-mode": "cors" }])
    ("rejects browser-origin requests before minting", async headers => {
      const ctx = httpContext(); const result = await handleNativeHostedTaskCapability(ctx, request(args, headers));
      expect(result.status).toBe(403); expect(ctx.runAction).not.toHaveBeenCalled(); expect(ctx.runMutation).not.toHaveBeenCalled();
    });
  it("rejects missing identity before reading a malformed body", async () => {
    const ctx = { ...httpContext(), auth: { getUserIdentity: async () => null } };
    const result = await handleNativeHostedTaskCapability(ctx, request("invalid"));
    expect(result.status).toBe(401); expect(ctx.runMutation).not.toHaveBeenCalled();
  });
  it("bounds request bytes and rejects raw task data without consuming a mint", async () => {
    const ctx = httpContext();
    for (const body of [{ ...args, input: "private" }, "x".repeat(2049)]) {
      expect((await handleNativeHostedTaskCapability(ctx, request(body))).status).toBe(400);
    }
    expect(ctx.runAction).not.toHaveBeenCalled(); expect(ctx.runMutation).not.toHaveBeenCalled();
  });
  it("returns rate limiting without minting and maps membership failure safely", async () => {
    const ctx = httpContext(); ctx.runMutation.mockRejectedValueOnce(new Error("rate-limited"));
    const result = await handleNativeHostedTaskCapability(ctx, request());
    expect(result.status).toBe(429); expect(result.headers.get("retry-after")).toBe("60");
    expect(ctx.runAction).not.toHaveBeenCalled();
    ctx.runAction.mockRejectedValueOnce(new Error("Active Mivlet workspace membership is required."));
    const denied = await handleNativeHostedTaskCapability(ctx, request());
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ status: "error", errorMessage: "membership-required" });
  });
});

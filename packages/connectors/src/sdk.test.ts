import { describe, expect, it, vi } from "vitest";
import type {
  ConnectorAdapter,
  ConnectorApprovalBoundary,
  ConnectorAccountSession
} from "./sdk";
import { ConnectorRuntime, tokenExpiresSoon } from "./sdk";
import type { ConnectorApprovalRecord, ConnectorTokenSet } from "@fable/protocol";

function fixtureAdapter(overrides: Partial<ConnectorAdapter> = {}): ConnectorAdapter {
  return {
    id: "fixture",
    capabilities: [
      { id: "items.read", kind: "read", consequential: false, description: "Read items" },
      { id: "items.publish", kind: "write", consequential: true, description: "Publish item" }
    ],
    startAuth: vi.fn(),
    completeAuth: vi.fn(),
    refresh: vi.fn(async (tokens) => ({ ...tokens, accessToken: "refreshed" })),
    revoke: vi.fn(async () => undefined),
    read: vi.fn(async () => ({ items: ["one"] })),
    write: vi.fn(async () => ({ id: "remote-1" })),
    ...overrides
  };
}

function session(tokens?: Partial<ConnectorTokenSet>): ConnectorAccountSession {
  return {
    connectorId: "fixture",
    account: { id: "account-1", displayName: "Fixture Account" },
    tokens: {
      accessToken: "access",
      tokenType: "Bearer",
      scopes: [],
      ...tokens
    }
  };
}

function approvals(
  approve: (record: ConnectorApprovalRecord) => ConnectorApprovalRecord = (record) => ({
    ...record,
    result: "approved",
    decidedAt: "2026-06-27T12:00:01.000Z"
  })
): ConnectorApprovalBoundary {
  return {
    approve: vi.fn(async (record) => approve(record)),
    complete: vi.fn(async () => undefined)
  };
}

describe("ConnectorRuntime", () => {
  it("registers adapters once", () => {
    const runtime = new ConnectorRuntime({ approvals: approvals() });
    const adapter = fixtureAdapter();
    runtime.register(adapter);
    expect(runtime.list()).toEqual(["fixture"]);
    expect(() => runtime.register(adapter)).toThrow("already registered");
  });

  it("refreshes expiring tokens before a read", async () => {
    const adapter = fixtureAdapter();
    const runtime = new ConnectorRuntime({
      approvals: approvals(),
      now: () => new Date("2026-06-27T12:00:00.000Z")
    });
    runtime.register(adapter);
    const account = session({ expiresAt: "2026-06-27T12:00:30.000Z" });
    await runtime.read(account, { capability: "items.read", input: {} });
    expect(adapter.refresh).toHaveBeenCalledOnce();
    expect(account.tokens.accessToken).toBe("refreshed");
  });

  it("rejects a forged or mismatched approval before an external write", async () => {
    const adapter = fixtureAdapter();
    const runtime = new ConnectorRuntime({
      approvals: approvals((record) => ({ ...record, result: "approved", target: "other" }))
    });
    runtime.register(adapter);
    await expect(
      runtime.write(session(), {
        capability: "items.publish",
        input: {},
        target: "production",
        preview: "Publish release",
        riskLevel: "high"
      })
    ).rejects.toMatchObject({ code: "approval-required" });
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it("requires a fresh per-action approval and records the execution result", async () => {
    const boundary = approvals();
    const adapter = fixtureAdapter();
    const runtime = new ConnectorRuntime({
      approvals: boundary,
      now: () => new Date("2026-06-27T12:00:00.000Z")
    });
    runtime.register(adapter);
    await runtime.write(session(), {
      capability: "items.publish",
      input: { title: "Release" },
      target: "production",
      preview: "Publish Release",
      riskLevel: "high"
    });
    expect(boundary.approve).toHaveBeenCalledOnce();
    expect(adapter.write).toHaveBeenCalledOnce();
    expect(boundary.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorId: "fixture",
        accountId: "account-1",
        proposedAction: "items.publish",
        target: "production",
        preview: "Publish Release",
        riskLevel: "high",
        result: "executed",
        actor: "user"
      })
    );
  });

  it("retries normalized retryable errors", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce({
        code: "rate-limited",
        connectorId: "fixture",
        message: "slow down",
        retryable: true,
        retryAfter: "0"
      })
      .mockResolvedValueOnce({ items: ["ok"] });
    const adapter = fixtureAdapter({ read });
    const runtime = new ConnectorRuntime({
      approvals: approvals(),
      sleep: vi.fn(async () => undefined)
    });
    runtime.register(adapter);
    await expect(runtime.read(session(), { capability: "items.read", input: {} })).resolves.toEqual({
      items: ["ok"]
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("refreshes and retries once when provider egress reports expired auth", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce({
        code: "expired-auth",
        connectorId: "fixture",
        message: "expired",
        retryable: false
      })
      .mockResolvedValueOnce({ items: ["after-refresh"] });
    const adapter = fixtureAdapter({ read });
    const runtime = new ConnectorRuntime({ approvals: approvals() });
    runtime.register(adapter);
    const account = session({ refreshToken: "refresh" });
    await expect(runtime.read(account, { capability: "items.read", input: {} })).resolves.toEqual({
      items: ["after-refresh"]
    });
    expect(adapter.refresh).toHaveBeenCalledOnce();
    expect(read).toHaveBeenLastCalledWith(
      { capability: "items.read", input: {} },
      expect.objectContaining({ accessToken: "refreshed" })
    );
  });
});

it("uses a refresh leeway for token expiry", () => {
  expect(
    tokenExpiresSoon(
      {
        accessToken: "access",
        tokenType: "Bearer",
        scopes: [],
        expiresAt: "2026-06-27T12:00:30.000Z"
      },
      new Date("2026-06-27T12:00:00.000Z")
    )
  ).toBe(true);
});

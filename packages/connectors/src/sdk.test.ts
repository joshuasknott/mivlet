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
        result: "completed",
        actor: "user"
      })
    );
  });

  it("binds the full exact action into a secret-free canonical fingerprint", async () => {
    const boundary = approvals();
    const adapter = fixtureAdapter();
    const runtime = new ConnectorRuntime({
      approvals: boundary,
      now: () => new Date("2026-06-27T12:00:00.000Z")
    });
    runtime.register(adapter);

    await runtime.write(session(), {
      capability: "items.publish",
      input: { z: 2, nested: { secretDraft: "private-value", a: 1 } },
      cursor: "cursor-1",
      target: "production",
      preview: "Publish release",
      riskLevel: "high",
      runId: "run-1",
      idempotencyKey: "publish-1"
    });
    const first = vi.mocked(boundary.approve).mock.calls[0][0].actionFingerprint;
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first).not.toContain("private-value");

    await runtime.write(session(), {
      capability: "items.publish",
      input: { nested: { a: 1, secretDraft: "private-value" }, z: 2 },
      cursor: "cursor-1",
      target: "production",
      preview: "Publish release",
      riskLevel: "high",
      runId: "run-1",
      idempotencyKey: "publish-1"
    });
    const second = vi.mocked(boundary.approve).mock.calls[1][0].actionFingerprint;
    expect(second).toBe(first);
  });

  it("executes the exact snapshotted input even if the caller mutates its object during approval", async () => {
    const input = { title: "Approved title", nested: { publish: true } };
    const boundary = approvals((record) => {
      input.title = "Substituted title";
      input.nested.publish = false;
      return { ...record, result: "approved", decidedAt: "2026-06-27T12:00:01.000Z" };
    });
    const adapter = fixtureAdapter();
    const runtime = new ConnectorRuntime({ approvals: boundary });
    runtime.register(adapter);

    await runtime.write(session(), {
      capability: "items.publish",
      input,
      target: "production",
      preview: "Publish approved title",
      riskLevel: "high"
    });

    expect(adapter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { title: "Approved title", nested: { publish: true } }
      }),
      expect.anything()
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

  it("respects custom maxRetries option and sleep delays on retryable failure", async () => {
    const read = vi
      .fn()
      .mockRejectedValue({
        code: "rate-limited",
        connectorId: "fixture",
        message: "slow down",
        retryable: true
      });
    const adapter = fixtureAdapter({ read });
    const sleep = vi.fn(async () => undefined);
    const runtime = new ConnectorRuntime({
      approvals: approvals(),
      maxRetries: 3,
      sleep
    });
    runtime.register(adapter);
    await expect(runtime.read(session(), { capability: "items.read", input: {} })).rejects.toThrow();
    // 1 initial attempt + 3 retries = 4 attempts total
    expect(read).toHaveBeenCalledTimes(4);
    // sleep called 3 times: 100 * 2^0, 100 * 2^1, 100 * 2^2
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
    expect(sleep).toHaveBeenNthCalledWith(3, 400);
  });

  it("does not retry when the error is marked non-retryable", async () => {
    const read = vi.fn().mockRejectedValue({
      code: "invalid-request",
      connectorId: "fixture",
      message: "bad request",
      retryable: false
    });
    const adapter = fixtureAdapter({ read });
    const sleep = vi.fn(async () => undefined);
    const runtime = new ConnectorRuntime({ approvals: approvals(), sleep });
    runtime.register(adapter);
    await expect(runtime.read(session(), { capability: "items.read", input: {} })).rejects.toThrow();
    expect(read).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("propagates token refresh errors without retrying operation", async () => {
    const refresh = vi.fn().mockRejectedValue(new Error("Refresh service down"));
    const adapter = fixtureAdapter({ refresh });
    const runtime = new ConnectorRuntime({
      approvals: approvals(),
      now: () => new Date("2026-06-27T12:00:00.000Z")
    });
    runtime.register(adapter);
    // Expiring token to trigger refresh
    const account = session({ expiresAt: "2026-06-27T12:00:30.000Z" });
    await expect(runtime.read(account, { capability: "items.read", input: {} })).rejects.toThrow("Refresh service down");
    expect(refresh).toHaveBeenCalledOnce();
    expect(adapter.read).not.toHaveBeenCalled();
  });

  it("does not refresh token when token has not expired and expiresAt is far in future or null", async () => {
    const adapter = fixtureAdapter();
    const runtime = new ConnectorRuntime({
      approvals: approvals(),
      now: () => new Date("2026-06-27T12:00:00.000Z")
    });
    runtime.register(adapter);
    // 1. Far in future
    const account1 = session({ expiresAt: "2026-06-27T13:00:00.000Z" });
    await runtime.read(account1, { capability: "items.read", input: {} });
    expect(adapter.refresh).not.toHaveBeenCalled();

    // 2. null expiresAt
    const account2 = session({ expiresAt: undefined });
    await runtime.read(account2, { capability: "items.read", input: {} });
    expect(adapter.refresh).not.toHaveBeenCalled();
  });

  it("propagates cancellation signal and AbortError", async () => {
    const read = vi.fn().mockImplementation(async (req) => {
      if (req.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return { items: [] };
    });
    const adapter = fixtureAdapter({ read });
    const runtime = new ConnectorRuntime({ approvals: approvals() });
    runtime.register(adapter);

    const controller = new AbortController();
    controller.abort();

    await expect(
      runtime.read(session(), { capability: "items.read", input: {}, signal: controller.signal })
    ).rejects.toThrow(/aborted/);
    expect(read).toHaveBeenCalledOnce();
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

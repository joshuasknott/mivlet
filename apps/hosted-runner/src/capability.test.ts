import {
  signHostedExecutionCapability,
  verifyHostedExecutionCapability,
  type HostedExecutionCapabilityPayload
} from "@fable/protocol";
import { describe, expect, it } from "vitest";
import { authorizeCapabilityRequest, type CapabilityNonceStore } from "./request-auth";

const signingKey = "runner-signing-secret-with-at-least-thirty-two-ch";
const serviceKey = "runner-service-secret-with-at-least-thirty-two-ch";
const issuedAt = Date.UTC(2026, 7, 24, 16, 0, 0);

function payload(overrides: Partial<HostedExecutionCapabilityPayload> = {}): HostedExecutionCapabilityPayload {
  return {
    version: 1,
    computerId: "computer-workspace-agent",
    generation: 3,
    scopes: ["process:launch", "process:inspect", "process:kill"],
    issuedAt,
    expiresAt: issuedAt + 120_000,
    nonce: "capability-test-nonce",
    ...overrides
  };
}

class MemoryNonceStore implements CapabilityNonceStore {
  readonly consumed = new Set<string>();

  async consume(input: { nonce: string; generation: number; expiresAt: number }): Promise<void> {
    if (this.consumed.has(input.nonce)) {
      const error = new Error("capability-replayed");
      error.name = "HostedComputerOperationError";
      throw error;
    }
    this.consumed.add(input.nonce);
  }
}

describe("hosted execution capabilities", () => {
  it("authorizes only the signed computer, generation, and requested operation", async () => {
    const token = await signHostedExecutionCapability(signingKey, payload());
    await expect(verifyHostedExecutionCapability(signingKey, token, {
      computerId: "computer-workspace-agent",
      scope: "process:launch",
      generation: 3,
      now: issuedAt + 30_000
    })).resolves.toMatchObject({ generation: 3, nonce: "capability-test-nonce" });
    await expect(verifyHostedExecutionCapability(signingKey, token, {
      computerId: "another-computer",
      scope: "process:launch",
      generation: 3,
      now: issuedAt + 30_000
    })).rejects.toThrow("capability-rejected");
    await expect(verifyHostedExecutionCapability(signingKey, token, {
      computerId: "computer-workspace-agent",
      scope: "process:launch",
      generation: 2,
      now: issuedAt + 30_000
    })).rejects.toThrow("capability-rejected");
  });

  it("rejects tampering, expiry, and missing scopes", async () => {
    const token = await signHostedExecutionCapability(signingKey, payload({ scopes: ["process:inspect"] }));
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    await expect(verifyHostedExecutionCapability(signingKey, tampered, {
      computerId: "computer-workspace-agent",
      scope: "process:inspect",
      generation: 3,
      now: issuedAt + 30_000
    })).rejects.toThrow("invalid-capability");
    await expect(verifyHostedExecutionCapability(signingKey, token, {
      computerId: "computer-workspace-agent",
      scope: "process:kill",
      generation: 3,
      now: issuedAt + 30_000
    })).rejects.toThrow("capability-rejected");
    await expect(verifyHostedExecutionCapability(signingKey, token, {
      computerId: "computer-workspace-agent",
      scope: "process:inspect",
      generation: 3,
      now: issuedAt + 120_000
    })).rejects.toThrow("capability-rejected");
  });

  it("rejects excessive lifetime and weak root secrets", async () => {
    await expect(signHostedExecutionCapability(signingKey, payload({
      expiresAt: issuedAt + 5 * 60_000 + 1
    }))).rejects.toThrow("invalid-capability");
    await expect(signHostedExecutionCapability("short", payload())).rejects.toThrow(
      "capability-configuration-required"
    );
  });

  it("accepts the capability header without accepting it as a service credential", async () => {
    const now = Date.now();
    const token = await signHostedExecutionCapability(signingKey, payload({
      issuedAt: now,
      expiresAt: now + 120_000,
      scopes: ["process:launch"]
    }));
    const request = new Request("https://runner.example/v1/computers/computer-workspace-agent/processes", {
      method: "POST",
      headers: { Authorization: `FableCapability ${token}` }
    });
    await expect(authorizeCapabilityRequest(
      request,
      signingKey,
      "computer-workspace-agent",
      "process:launch",
      new MemoryNonceStore()
    )).resolves.toEqual({ authorized: true, expectedGeneration: 3 });
    await expect(authorizeCapabilityRequest(
      request,
      signingKey,
      "computer-workspace-agent",
      "process:kill",
      new MemoryNonceStore()
    )).resolves.toEqual({ authorized: false });
  });

  it("rejects service Bearer on process launch", async () => {
    const store = new MemoryNonceStore();
    for (const secret of [serviceKey, signingKey]) {
      const request = new Request("https://runner.example/v1/computers/computer-workspace-agent/processes", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` }
      });
      await expect(authorizeCapabilityRequest(
        request,
        signingKey,
        "computer-workspace-agent",
        "process:launch",
        store
      )).resolves.toEqual({ authorized: false });
    }
    expect(store.consumed.size).toBe(0);
  });

  it("does not accept a capability signed with the service Bearer secret", async () => {
    const now = Date.now();
    const token = await signHostedExecutionCapability(serviceKey, payload({
      issuedAt: now,
      expiresAt: now + 120_000,
      scopes: ["process:launch"]
    }));
    const request = new Request("https://runner.example/v1/computers/computer-workspace-agent/processes", {
      method: "POST",
      headers: { Authorization: `FableCapability ${token}` }
    });
    await expect(authorizeCapabilityRequest(
      request,
      signingKey,
      "computer-workspace-agent",
      "process:launch",
      new MemoryNonceStore()
    )).resolves.toEqual({ authorized: false });
  });

  it("rejects capability replay after the nonce is consumed", async () => {
    const now = Date.now();
    const token = await signHostedExecutionCapability(signingKey, payload({
      issuedAt: now,
      expiresAt: now + 120_000,
      scopes: ["process:launch"],
      nonce: "capability-replay-nonce"
    }));
    const request = new Request("https://runner.example/v1/computers/computer-workspace-agent/processes", {
      method: "POST",
      headers: { Authorization: `FableCapability ${token}` }
    });
    const store = new MemoryNonceStore();
    await expect(authorizeCapabilityRequest(
      request,
      signingKey,
      "computer-workspace-agent",
      "process:launch",
      store
    )).resolves.toEqual({ authorized: true, expectedGeneration: 3 });
    await expect(authorizeCapabilityRequest(
      request,
      signingKey,
      "computer-workspace-agent",
      "process:launch",
      store
    )).rejects.toThrow("capability-replayed");
  });

  it("fails closed when the nonce store is unavailable", async () => {
    const now = Date.now();
    const token = await signHostedExecutionCapability(signingKey, payload({
      issuedAt: now,
      expiresAt: now + 120_000,
      scopes: ["process:launch"]
    }));
    const request = new Request("https://runner.example/v1/computers/computer-workspace-agent/processes", {
      method: "POST",
      headers: { Authorization: `FableCapability ${token}` }
    });
    await expect(authorizeCapabilityRequest(
      request,
      signingKey,
      "computer-workspace-agent",
      "process:launch",
      {
        consume: async () => {
          throw Object.assign(new Error("capability-store-unavailable"), {
            name: "HostedComputerOperationError"
          });
        }
      }
    )).rejects.toThrow("capability-store-unavailable");
  });

  it("keeps browser navigation separate from read-only snapshots", async () => {
    const now = Date.now();
    const token = await signHostedExecutionCapability(signingKey, payload({
      issuedAt: now,
      expiresAt: now + 120_000,
      scopes: ["browser:snapshot"]
    }));
    const request = new Request("https://runner.example/v1/computers/computer-workspace-agent/browser/snapshot", {
      headers: { Authorization: `FableCapability ${token}` }
    });
    await expect(authorizeCapabilityRequest(
      request,
      signingKey,
      "computer-workspace-agent",
      "browser:snapshot",
      new MemoryNonceStore()
    )).resolves.toEqual({ authorized: true, expectedGeneration: 3 });
    await expect(authorizeCapabilityRequest(
      request,
      signingKey,
      "computer-workspace-agent",
      "browser:navigate",
      new MemoryNonceStore()
    )).resolves.toEqual({ authorized: false });
    await expect(authorizeCapabilityRequest(
      request,
      signingKey,
      "computer-workspace-agent",
      "browser:act",
      new MemoryNonceStore()
    )).resolves.toEqual({ authorized: false });
  });

  it("keeps browser actions on their own one-time capability scope", async () => {
    const now = Date.now();
    const token = await signHostedExecutionCapability(signingKey, payload({
      issuedAt: now,
      expiresAt: now + 120_000,
      scopes: ["browser:act"]
    }));
    const request = new Request("https://runner.example/v1/computers/computer-workspace-agent/browser/act", {
      method: "POST",
      headers: { Authorization: `FableCapability ${token}` }
    });
    await expect(authorizeCapabilityRequest(
      request,
      signingKey,
      "computer-workspace-agent",
      "browser:act",
      new MemoryNonceStore()
    )).resolves.toEqual({ authorized: true, expectedGeneration: 3 });
    await expect(authorizeCapabilityRequest(
      request,
      signingKey,
      "computer-workspace-agent",
      "browser:navigate",
      new MemoryNonceStore()
    )).resolves.toEqual({ authorized: false });
  });
});

import {
  signHostedExecutionCapability,
  verifyHostedExecutionCapability,
  type HostedExecutionCapabilityPayload
} from "@fable/protocol";
import { describe, expect, it } from "vitest";
import { authorizeCapabilityRequest } from "./request-auth";

const secret = "runner-root-secret-with-at-least-thirty-two-characters";
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

describe("hosted execution capabilities", () => {
  it("authorizes only the signed computer and requested operation", async () => {
    const token = await signHostedExecutionCapability(secret, payload());
    await expect(verifyHostedExecutionCapability(secret, token, {
      computerId: "computer-workspace-agent",
      scope: "process:launch",
      now: issuedAt + 30_000
    })).resolves.toMatchObject({ generation: 3, nonce: "capability-test-nonce" });
    await expect(verifyHostedExecutionCapability(secret, token, {
      computerId: "another-computer",
      scope: "process:launch",
      now: issuedAt + 30_000
    })).rejects.toThrow("capability-rejected");
  });

  it("rejects tampering, expiry, and missing scopes", async () => {
    const token = await signHostedExecutionCapability(secret, payload({ scopes: ["process:inspect"] }));
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    await expect(verifyHostedExecutionCapability(secret, tampered, {
      computerId: "computer-workspace-agent",
      scope: "process:inspect",
      now: issuedAt + 30_000
    })).rejects.toThrow("invalid-capability");
    await expect(verifyHostedExecutionCapability(secret, token, {
      computerId: "computer-workspace-agent",
      scope: "process:kill",
      now: issuedAt + 30_000
    })).rejects.toThrow("capability-rejected");
    await expect(verifyHostedExecutionCapability(secret, token, {
      computerId: "computer-workspace-agent",
      scope: "process:inspect",
      now: issuedAt + 120_000
    })).rejects.toThrow("capability-rejected");
  });

  it("rejects excessive lifetime and weak root secrets", async () => {
    await expect(signHostedExecutionCapability(secret, payload({
      expiresAt: issuedAt + 5 * 60_000 + 1
    }))).rejects.toThrow("invalid-capability");
    await expect(signHostedExecutionCapability("short", payload())).rejects.toThrow(
      "capability-configuration-required"
    );
  });

  it("accepts the capability header without accepting it as a service credential", async () => {
    const now = Date.now();
    const token = await signHostedExecutionCapability(secret, payload({
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
      secret,
      "computer-workspace-agent",
      "process:launch"
    )).resolves.toEqual({ authorized: true, expectedGeneration: 3 });
    await expect(authorizeCapabilityRequest(
      request,
      secret,
      "computer-workspace-agent",
      "process:kill"
    )).resolves.toEqual({ authorized: false });
  });

  it("keeps browser navigation separate from read-only snapshots", async () => {
    const now = Date.now();
    const token = await signHostedExecutionCapability(secret, payload({
      issuedAt: now,
      expiresAt: now + 120_000,
      scopes: ["browser:snapshot"]
    }));
    const request = new Request("https://runner.example/v1/computers/computer-workspace-agent/browser/snapshot", {
      headers: { Authorization: `FableCapability ${token}` }
    });
    await expect(authorizeCapabilityRequest(
      request,
      secret,
      "computer-workspace-agent",
      "browser:snapshot"
    )).resolves.toEqual({ authorized: true, expectedGeneration: 3 });
    await expect(authorizeCapabilityRequest(
      request,
      secret,
      "computer-workspace-agent",
      "browser:navigate"
    )).resolves.toEqual({ authorized: false });
    await expect(authorizeCapabilityRequest(
      request,
      secret,
      "computer-workspace-agent",
      "browser:act"
    )).resolves.toEqual({ authorized: false });
  });

  it("keeps browser actions on their own one-time capability scope", async () => {
    const now = Date.now();
    const token = await signHostedExecutionCapability(secret, payload({
      issuedAt: now,
      expiresAt: now + 120_000,
      scopes: ["browser:act"]
    }));
    const request = new Request("https://runner.example/v1/computers/computer-workspace-agent/browser/act", {
      method: "POST",
      headers: { Authorization: `FableCapability ${token}` }
    });
    await expect(authorizeCapabilityRequest(request, secret, "computer-workspace-agent", "browser:act"))
      .resolves.toEqual({ authorized: true, expectedGeneration: 3 });
    await expect(authorizeCapabilityRequest(request, secret, "computer-workspace-agent", "browser:navigate"))
      .resolves.toEqual({ authorized: false });
  });

});

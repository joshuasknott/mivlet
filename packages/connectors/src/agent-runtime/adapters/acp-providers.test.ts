import { describe, expect, it } from "vitest";
import type { BackendAuthState, BackendCapability } from "@fable/protocol";
import {
  ACP_PROVIDERS,
  detectAcpRuntime,
  type AcpCliProbe,
  type AcpCliProbeOutcome
} from "./acp-providers";

describe("ACP_PROVIDERS definitions", () => {
  it("declares cursor and grok with their executable specs", () => {
    expect(Object.keys(ACP_PROVIDERS).sort()).toEqual(["cursor", "grok"]);
    expect(ACP_PROVIDERS.cursor.executable).toBe("cursor");
    expect(ACP_PROVIDERS.cursor.authProbeArgs).toContain("agent");
    expect(ACP_PROVIDERS.grok.executable).toBe("grok");
  });

  it("carries no bundled secret and no redistribution claim", () => {
    for (const def of Object.values(ACP_PROVIDERS)) {
      expect(def.executable.length).toBeGreaterThan(0);
      // auth probe args must not contain a token
      const joined = def.authProbeArgs.join(" ");
      expect(joined.toLowerCase()).not.toContain("token");
      expect(joined.toLowerCase()).not.toContain("secret");
    }
  });

  it("marks grok as entitlement-pending (no tier claims)", () => {
    expect(ACP_PROVIDERS.grok.entitlementsPending).toBe(true);
    expect(ACP_PROVIDERS.cursor.entitlementsPending).toBe(false);
  });
});

describe("detectAcpRuntime", () => {
  const cases: Array<{
    name: string;
    outcome: AcpCliProbeOutcome;
    expectedAuth: BackendAuthState;
    expectStreaming: boolean;
  }> = [
    { name: "not-installed", outcome: "not-installed", expectedAuth: "install-required", expectStreaming: false },
    { name: "signed-out", outcome: "signed-out", expectedAuth: "needs-auth", expectStreaming: false },
    { name: "connected", outcome: "connected", expectedAuth: "connected", expectStreaming: true },
    { name: "auth-failed", outcome: "auth-failed", expectedAuth: "unavailable", expectStreaming: false },
    { name: "probe-unavailable", outcome: "unavailable", expectedAuth: "unavailable", expectStreaming: false }
  ];

  for (const { name, outcome, expectedAuth, expectStreaming } of cases) {
    it(`maps a ${name} probe to authState=${expectedAuth}`, async () => {
      const probe: AcpCliProbe = async () => outcome;
      const result = await detectAcpRuntime("cursor", probe);
      expect(result.authState).toBe(expectedAuth);
      const caps: readonly BackendCapability[] = result.capabilities;
      expect(caps.includes("streaming")).toBe(expectStreaming);
    });
  }

  it("reports no capabilities for a not-installed CLI (fail-closed)", async () => {
    const probe: AcpCliProbe = async () => "not-installed";
    const result = await detectAcpRuntime("cursor", probe);
    expect(result.capabilities).toEqual([]);
    expect(result.authState).toBe("install-required");
  });

  it("reports the full ACP capability set only when connected", async () => {
    const probe: AcpCliProbe = async () => "connected";
    const result = await detectAcpRuntime("cursor", probe);
    expect(result.capabilities).toEqual(
      expect.arrayContaining([
        "streaming",
        "tool-requests",
        "approvals",
        "cancellation",
        "file-changes",
        "threads"
      ])
    );
    // usage-cost is never claimed for a subscription/CLI ACP provider.
    expect(result.capabilities).not.toContain("usage-cost");
  });

  it("returns grok entitlements as pending until a post-login check", async () => {
    const probe: AcpCliProbe = async () => "connected";
    const connected = await detectAcpRuntime("grok", probe);
    expect(connected.entitlementsPending).toBe(true);
    const signedOut = await detectAcpRuntime("grok", async () => "signed-out");
    expect(signedOut.entitlementsPending).toBe(true);
  });

  it("throws for an unknown provider id", async () => {
    const probe: AcpCliProbe = async () => "connected";
    await expect(detectAcpRuntime("codex" as never, probe)).rejects.toThrow();
  });
});

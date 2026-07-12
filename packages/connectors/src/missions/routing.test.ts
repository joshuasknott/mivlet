import { describe, expect, it } from "vitest";
import { MissionRoutingError, selectMissionProviderRoute, type MissionRouteCandidate, type MissionRouteRequest } from "./routing";

const boundaries = { privacyBoundary: "private", billingBoundary: "personal", providerBoundary: "approved", placementBoundary: "local-or-approved-hosted" };
function candidate(id: string, overrides: Partial<MissionRouteCandidate> = {}): MissionRouteCandidate {
  return {
    route: {
      id, recordType: "provider-route", connectionId: `connection-${id}`, kind: "api-model", displayName: id,
      providerFamily: id, modelOrRuntimeReference: "model", state: "available", health: { state: "healthy" },
      placement: { allowedKinds: ["fable-managed"], requiresCredentialHoldingNode: true }, boundaries,
      credentialBinding: { kind: "fable-managed", state: "available" }, workspaceId: "workspace-1", authority: "local",
      visibility: "member-private", ownerMemberId: "member-1", schemaVersion: 1, revision: 1,
      createdByInternalUserId: "user-1", createdAt: "2026-07-12T00:00:00Z", updatedAt: "2026-07-12T00:00:00Z"
    } as never,
    capabilityIds: ["knowledge.content.search"], supportsTools: true, contextWindowTokens: 64_000,
    qualityScore: 0.8, estimatedLatencyMs: 1_000, estimatedCostMinorUnits: 5, risk: "medium", ...overrides
  };
}
function request(overrides: Partial<MissionRouteRequest> = {}): MissionRouteRequest {
  return {
    workspaceId: "workspace-1", capabilityId: "knowledge.content.search", requiredInputTokens: 2_000,
    requiredOutputTokens: 1_000, requiresTools: true, allowedPlacementKinds: ["fable-managed"], boundaries,
    allowDegraded: false, maximumRisk: "medium", maxCostMinorUnits: 20, currency: "USD",
    selectedAt: "2026-07-12T01:00:00Z", ...overrides
  };
}

describe("mission provider routing", () => {
  it("selects deterministically from quality, cost, and speed", () => {
    const decision = selectMissionProviderRoute(request(), [
      candidate("route-slow", { qualityScore: 0.9, estimatedLatencyMs: 8_000, estimatedCostMinorUnits: 10 }),
      candidate("route-balanced", { qualityScore: 0.88, estimatedLatencyMs: 500, estimatedCostMinorUnits: 2 })
    ]);
    expect(decision.selection.providerRouteId).toBe("route-balanced");
    expect(decision.selection.boundaryPolicyRef).toContain("boundary:private");
  });

  it("enforces provider pins and exclusions without silent fallback", () => {
    expect(selectMissionProviderRoute(request({ preference: { policy: "require", providerRouteIds: ["route-pinned"] as never, allowFallback: false } }), [
      candidate("route-other"), candidate("route-pinned", { qualityScore: 0.2 })
    ]).selection.providerRouteId).toBe("route-pinned");
    expect(() => selectMissionProviderRoute(request({ preference: { policy: "exclude", providerRouteIds: ["route-only"] as never, allowFallback: false } }), [candidate("route-only")]))
      .toThrow(MissionRoutingError);
  });

  it("permits only explicit same-boundary fallback and reports rejected routes", () => {
    const decision = selectMissionProviderRoute(request({ preference: { policy: "prefer", providerRouteIds: ["route-offline"] as never, allowFallback: true } }), [
      candidate("route-offline", { route: { ...candidate("route-offline").route, state: "unavailable" } as never }),
      candidate("route-wrong-boundary", { route: { ...candidate("route-wrong-boundary").route, boundaries: { ...boundaries, privacyBoundary: "public" } } as never }),
      candidate("route-fallback")
    ]);
    expect(decision.selection.providerRouteId).toBe("route-fallback");
    expect(decision.selection.fallbackFromProviderRouteId).toBe("route-offline");
    expect(decision.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerRouteId: "route-offline", reasons: expect.arrayContaining(["route-unavailable"]) }),
      expect.objectContaining({ providerRouteId: "route-wrong-boundary", reasons: expect.arrayContaining(["boundary-mismatch"]) })
    ]));
  });

  it("fails closed for tools, context, cost, health, placement, and risk", () => {
    const constrained = candidate("route-denied", {
      supportsTools: false, contextWindowTokens: 100, estimatedCostMinorUnits: 30, risk: "high",
      route: { ...candidate("route-denied").route, health: { state: "offline" }, placement: { allowedKinds: ["local-desktop"], requiresCredentialHoldingNode: true } } as never
    });
    try {
      selectMissionProviderRoute(request(), [constrained]);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(MissionRoutingError);
      expect((error as MissionRoutingError).rejected[0]?.reasons).toEqual(expect.arrayContaining([
        "route-unhealthy", "tools-unavailable", "context-insufficient", "placement-denied", "risk-exceeded", "cost-exceeded"
      ]));
    }
  });

  it("selects without inventing quality, latency, or cost observations", () => {
    const decision = selectMissionProviderRoute(request({ maxCostMinorUnits: undefined }), [
      candidate("route-unobserved", { qualityScore: undefined, estimatedLatencyMs: undefined, estimatedCostMinorUnits: undefined })
    ]);
    expect(decision.reason).toContain("quality unobserved");
    expect(decision.reason).toContain("cost unobserved");
    expect(decision.reason).toContain("latency unobserved");
  });
});

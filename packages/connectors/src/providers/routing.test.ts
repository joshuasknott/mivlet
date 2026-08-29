import { describe, expect, it } from "vitest";
import { ProviderRoutingError, selectProviderRoute, type ProviderRouteCandidate, type ProviderRouteRequest } from "./routing";

const boundaries = { privacyBoundary: "private", billingBoundary: "personal", providerBoundary: "approved", placementBoundary: "local-or-approved-hosted" };
const policy = "native-policy:cited-brief:v1:test";
function quality(id: string, passedCount = 4, sampleCount = 5, policyRevisionRef = policy) {
  return {
    reference: `route-policy-summary:v1:${id}`,
    policyRevisionRef,
    sampleCount,
    passedCount,
    routingScoreBasisPoints: Math.floor((passedCount + 1) * 10_000 / (sampleCount + 2)),
    latestEvaluatedAt: "2026-07-12T00:45:00Z"
  };
}
function pricing(id: string, inputRateMinorUnits = 1, outputRateMinorUnits = 3) {
  return {
    reference: `route-pricing:v1:${id}`,
    currencyCode: "USD",
    inputRateMinorUnits,
    outputRateMinorUnits,
    unitTokens: 1_000,
    sourceUrl: "https://example.com/model-pricing",
    reviewedAt: "2026-07-13T00:00:00Z"
  };
}
function candidate(id: string, overrides: Partial<ProviderRouteCandidate> = {}): ProviderRouteCandidate {
  const observation = {
    reference: `route-observation-summary:v1:${id}`,
    sampleCount: 2,
    medianLatencyMs: 1_000,
    usageSampleCount: 1,
    latestObservedAt: "2026-07-12T00:30:00Z"
  };
  const result: ProviderRouteCandidate = {
    route: {
      id, recordType: "provider-route", connectionId: `connection-${id}`, kind: "api-model", displayName: id,
      providerFamily: id, modelOrRuntimeReference: "model", state: "available", health: { state: "healthy" },
      placement: { allowedKinds: ["fable-managed"], requiresCredentialHoldingNode: true }, boundaries,
      credentialBinding: { kind: "fable-managed", state: "available" }, workspaceId: "workspace-1", authority: "local",
      visibility: "member-private", ownerMemberId: "member-1", schemaVersion: 1, revision: 1,
      createdByInternalUserId: "user-1", createdAt: "2026-07-12T00:00:00Z", updatedAt: "2026-07-12T00:00:00Z"
    } as never,
    capabilityIds: ["knowledge.content.search"], supportsTools: true, contextWindowTokens: 64_000,
    quality: quality(id), estimatedLatencyMs: 1_000, observation, pricing: pricing(id), risk: "medium", ...overrides,
    ...(overrides.estimatedLatencyMs !== undefined && !Object.prototype.hasOwnProperty.call(overrides, "observation")
      ? { observation: { ...observation, medianLatencyMs: overrides.estimatedLatencyMs } }
      : {})
  };
  if (Object.prototype.hasOwnProperty.call(overrides, "estimatedLatencyMs")
    && overrides.estimatedLatencyMs === undefined
    && !Object.prototype.hasOwnProperty.call(overrides, "observation")) {
    delete result.observation;
  }
  return result;
}
function request(overrides: Partial<ProviderRouteRequest> = {}): ProviderRouteRequest {
  return {
    workspaceId: "workspace-1", capabilityId: "knowledge.content.search", requiredInputTokens: 2_000,
    requiredOutputTokens: 1_000, requiresTools: true, allowedPlacementKinds: ["fable-managed"], boundaries,
    allowDegraded: false, maximumRisk: "medium", maxCostMinorUnits: 20, currency: "USD",
    qualityPolicyRef: policy, selectedAt: "2026-07-12T01:00:00Z", ...overrides
  };
}

describe("provider routing", () => {
  it("selects deterministically from quality, cost, and speed", () => {
    const decision = selectProviderRoute(request(), [
      candidate("route-slow", { quality: quality("slow", 9, 10), estimatedLatencyMs: 8_000, pricing: pricing("slow", 2, 6) }),
      candidate("route-balanced", { quality: quality("balanced", 8, 10), estimatedLatencyMs: 500, pricing: pricing("balanced", 0, 2) })
    ]);
    expect(decision.selection.providerRouteId).toBe("route-balanced");
    expect(decision.selection.boundaryPolicyRef).toContain("boundary:private");
  });

  it("enforces provider pins and exclusions without silent fallback", () => {
    expect(selectProviderRoute(request({ preference: { policy: "require", providerRouteIds: ["route-pinned"] as never, allowFallback: false } }), [
      candidate("route-other"), candidate("route-pinned", { quality: quality("pinned", 0, 3) })
    ]).selection.providerRouteId).toBe("route-pinned");
    expect(() => selectProviderRoute(request({ preference: { policy: "exclude", providerRouteIds: ["route-only"] as never, allowFallback: false } }), [candidate("route-only")]))
      .toThrow(ProviderRoutingError);
  });

  it("permits only explicit same-boundary fallback and reports rejected routes", () => {
    const decision = selectProviderRoute(request({ preference: { policy: "prefer", providerRouteIds: ["route-offline"] as never, allowFallback: true } }), [
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
      supportsTools: false, contextWindowTokens: 100, pricing: pricing("denied", 0, 30), risk: "high",
      route: { ...candidate("route-denied").route, health: { state: "offline" }, placement: { allowedKinds: ["local-desktop"], requiresCredentialHoldingNode: true } } as never
    });
    try {
      selectProviderRoute(request(), [constrained]);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRoutingError);
      expect((error as ProviderRoutingError).rejected[0]?.reasons).toEqual(expect.arrayContaining([
        "route-unhealthy", "tools-unavailable", "context-insufficient", "placement-denied", "risk-exceeded", "cost-exceeded"
      ]));
    }
  });

  it("selects without inventing quality, latency, or cost observations", () => {
    const decision = selectProviderRoute(request({ maxCostMinorUnits: undefined }), [
      candidate("route-unobserved", { quality: undefined, estimatedLatencyMs: undefined, pricing: undefined })
    ]);
    expect(decision.reason).toContain("quality unobserved");
    expect(decision.reason).toContain("cost unobserved");
    expect(decision.reason).toContain("latency unobserved");
    expect(decision.selection.observation).toBeUndefined();
    expect(decision.selection.cost).toBeUndefined();
  });

  it("uses and binds policy evidence only for an exact requested evaluator revision", () => {
    const matched = selectProviderRoute(request(), [candidate("route-policy")]);
    expect(matched.selection.quality).toEqual(candidate("route-policy").quality);
    expect(matched.reason).toContain("policy evidence 4 of 5 outputs passed");

    const unmatched = selectProviderRoute(request({ qualityPolicyRef: "native-policy:other:v1" }), [
      candidate("route-policy")
    ]);
    expect(unmatched.selection.quality).toBeUndefined();
    expect(unmatched.reason).toContain("quality unobserved");
  });

  it("binds source-attributed exact-model cost into the immutable selection", () => {
    const decision = selectProviderRoute(request(), [candidate("route-priced")]);
    expect(decision.selection.cost).toMatchObject({
      reference: "route-pricing:v1:route-priced",
      estimatedInputTokens: 2_000,
      estimatedOutputTokens: 1_000,
      estimatedCostMinorUnits: 5,
      currencyCode: "USD"
    });
    expect(decision.reason).toContain("estimated cost 5 USD minor units");
  });

  it("rejects cost estimates without valid source-attributed pricing", () => {
    expect(() => selectProviderRoute(request(), [
      candidate("route-invalid-price", { pricing: { ...pricing("invalid"), sourceUrl: "http://localhost/pricing" } })
    ])).toThrow("Route cost requires valid source-attributed exact-model pricing evidence");
  });

  it("binds observed latency evidence into the immutable selection", () => {
    const decision = selectProviderRoute(request(), [candidate("route-observed")]);
    expect(decision.selection.observation).toEqual(candidate("route-observed").observation);
  });

  it("rejects observed latency without matching evidence", () => {
    expect(() => selectProviderRoute(request(), [
      candidate("route-invalid", { observation: undefined })
    ])).toThrow("Observed route latency requires a valid immutable observation snapshot");
  });
});

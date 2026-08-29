import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectNativeProviderRoute } from "./provider-route-selection";

const mocks = vi.hoisted(() => ({ listRoutes: vi.fn() }));
vi.mock("../runtime", () => ({
  listRuntimeNativeProviderRoutes: mocks.listRoutes,
}));

const route = {
  id: "provider-route-openai-gpt5",
  recordType: "provider-route",
  connectionId: "connection-openai",
  kind: "api-model",
  displayName: "OpenAI GPT-5",
  providerFamily: "openai",
  modelOrRuntimeReference: "gpt-5",
  state: "available",
  health: { state: "healthy" },
  placement: {
    allowedKinds: ["local-desktop"],
    requiresCredentialHoldingNode: true,
  },
  boundaries: {
    privacyBoundary: "installation-private",
    billingBoundary: "user-owned-provider",
    providerBoundary: "openai",
    placementBoundary: "local-credential-egress",
  },
  credentialBinding: {
    custody: "os-secure-store",
    state: "available",
    refreshSupported: false,
  },
  pricingSummary: {
    reference: "route-pricing:v1:gpt5",
    currencyCode: "USD",
    inputRateMinorUnits: 125,
    outputRateMinorUnits: 1000,
    unitTokens: 1_000_000,
    sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5",
    reviewedAt: "2026-07-13T00:00:00Z",
  },
  workspaceId: "workspace-1",
  visibility: "member-private",
  ownerMemberId: "member-1",
  authority: "local",
  schemaVersion: 1,
  revision: 1,
  createdByInternalUserId: "user-1",
  createdAt: "2026-07-12T10:00:00Z",
  updatedAt: "2026-07-12T10:00:00Z",
};

describe("native provider route selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listRoutes.mockResolvedValue([route]);
  });

  it("returns one workspace-fenced no-fallback route binding", async () => {
    await expect(
      selectNativeProviderRoute({
        providerId: "openai",
        model: "gpt-5",
        requiredInputTokens: 100,
        requiredOutputTokens: 1024,
        requiresTools: false,
      }),
    ).resolves.toMatchObject({
      workspaceId: "workspace-1",
      selection: {
        providerRouteId: "provider-route-openai-gpt5",
        boundaryPolicyRef:
          "boundary:installation-private:user-owned-provider:openai:local-credential-egress",
        cost: {
          estimatedInputTokens: 100,
          estimatedOutputTokens: 1024,
          estimatedCostMinorUnits: 2,
        },
      },
    });
  });

  it("fails closed when the selected model has no current account route", async () => {
    await expect(
      selectNativeProviderRoute({
        providerId: "openai",
        model: "gpt-5.2",
        requiredInputTokens: 100,
        requiredOutputTokens: 1024,
        requiresTools: false,
      }),
    ).rejects.toThrow("no authorized provider route");
  });

  it("authorizes only the exact configured custom model for plain chat", async () => {
    mocks.listRoutes.mockResolvedValue([
      {
        ...route,
        id: "provider-route-custom-fable-smoke",
        connectionId: "connection-custom",
        displayName: "Custom provider fable-smoke",
        providerFamily: "custom",
        modelOrRuntimeReference: "fable-smoke",
        pricingSummary: undefined,
        boundaries: {
          ...route.boundaries,
          billingBoundary: "user-owned-provider",
          providerBoundary: "custom",
        },
      },
    ]);

    await expect(
      selectNativeProviderRoute({
        providerId: "custom",
        model: "fable-smoke",
        requiredInputTokens: 100,
        requiredOutputTokens: 2048,
        requiresTools: false,
      }),
    ).resolves.toMatchObject({
      workspaceId: "workspace-1",
      selection: {
        providerRouteId: "provider-route-custom-fable-smoke",
        reason: expect.stringContaining("Custom provider fable-smoke"),
        boundaryPolicyRef:
          "boundary:installation-private:user-owned-provider:custom:local-credential-egress",
      },
    });

    await expect(
      selectNativeProviderRoute({
        providerId: "custom",
        model: "fable-smoke",
        requiredInputTokens: 100,
        requiredOutputTokens: 2048,
        requiresTools: true,
      }),
    ).rejects.toThrow("does not declare tool support");
  });
});

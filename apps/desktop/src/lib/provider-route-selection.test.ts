import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Spine } from "@fable/protocol";
import {
  selectNativeProviderRoute,
  selectRuntimeMissionWorkerRoute
} from "./provider-route-selection";

const mocks = vi.hoisted(() => ({ listRoutes: vi.fn() }));
vi.mock("../runtime", () => ({ listRuntimeNativeProviderRoutes: mocks.listRoutes }));

const route = {
  id: "provider-route-openai-gpt5", recordType: "provider-route", connectionId: "connection-openai",
  kind: "api-model", displayName: "OpenAI GPT-5", providerFamily: "openai", modelOrRuntimeReference: "gpt-5",
  state: "available", health: { state: "healthy" }, placement: { allowedKinds: ["local-desktop"], requiresCredentialHoldingNode: true },
  boundaries: { privacyBoundary: "member-private", billingBoundary: "account-owned-provider", providerBoundary: "openai", placementBoundary: "local-credential-egress" },
  credentialBinding: { custody: "os-secure-store", state: "available", refreshSupported: false },
  pricingSummary: {
    reference: "route-pricing:v1:gpt5", currencyCode: "USD", inputRateMinorUnits: 125,
    outputRateMinorUnits: 1000, unitTokens: 1_000_000,
    sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5", reviewedAt: "2026-07-13T00:00:00Z"
  },
  workspaceId: "workspace-1", visibility: "member-private", ownerMemberId: "member-1", authority: "local",
  schemaVersion: 1, revision: 1, createdByInternalUserId: "user-1", createdAt: "2026-07-12T10:00:00Z", updatedAt: "2026-07-12T10:00:00Z"
};

function missionWorker(
  preference: Spine.Missions.ProviderRoutePreference = {
    policy: "automatic",
    providerRouteIds: [],
    allowFallback: false
  }
): Spine.Missions.Worker {
  return {
    workspaceId: "workspace-1",
    visibility: "member-private",
    ownerMemberId: "member-1",
    authority: "local",
    schemaVersion: 1,
    revision: 1,
    createdByInternalUserId: "user-1",
    createdAt: "2026-07-12T10:00:00Z",
    updatedAt: "2026-07-12T10:00:00Z",
    id: "worker-1",
    runId: "run-1",
    status: "proposed",
    role: { kind: "specialist", title: "Draft", objective: "Draft.", responsibilities: ["Draft."] },
    context: [],
    capabilityIds: [],
    capabilityGrantIds: [],
    tools: [],
    routePreference: preference,
    placementPreference: {
      policy: "require",
      executionNodeIds: ["local-desktop"],
      locality: "local",
      allowTransfer: false
    },
    budget: { maxInputTokens: 100, maxOutputTokens: 1024 },
    stopConditions: [],
    outputContract: {
      slots: [{ key: "draft", description: "Draft", required: true }],
      includeEvidence: false,
      includeUncertainty: true,
      delivery: "run-result"
    }
  } as unknown as Spine.Missions.Worker;
}

describe("native provider route selection", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.listRoutes.mockResolvedValue([route]); });

  it("returns one workspace-fenced no-fallback route binding", async () => {
    await expect(selectNativeProviderRoute({
      providerId: "openai", model: "gpt-5", requiredInputTokens: 100,
      requiredOutputTokens: 1024, requiresTools: false
    })).resolves.toMatchObject({
      workspaceId: "workspace-1",
      selection: {
        providerRouteId: "provider-route-openai-gpt5",
        boundaryPolicyRef: expect.stringContaining("member-private"),
        cost: { estimatedInputTokens: 100, estimatedOutputTokens: 1024, estimatedCostMinorUnits: 2 }
      }
    });
  });

  it("fails closed when the selected model has no current account route", async () => {
    await expect(selectNativeProviderRoute({
      providerId: "openai", model: "gpt-5.2", requiredInputTokens: 100,
      requiredOutputTokens: 1024, requiresTools: false
    })).rejects.toThrow("no authorized provider route");
  });

  it("resolves a general worker at execution time inside its saved local policy", async () => {
    await expect(selectRuntimeMissionWorkerRoute(missionWorker())).resolves.toMatchObject({
      route: { id: "provider-route-openai-gpt5" },
      execution: {
        workspaceId: "workspace-1",
        selection: {
          providerRouteId: "provider-route-openai-gpt5"
        }
      }
    });
  });

  it("never compares automatic candidates across authority boundaries", async () => {
    mocks.listRoutes.mockResolvedValue([
      route,
      {
        ...route,
        id: "provider-route-other",
        boundaries: { ...route.boundaries, billingBoundary: "another-billing-owner" }
      }
    ]);
    await expect(selectRuntimeMissionWorkerRoute(missionWorker())).rejects.toThrow(
      "spans provider, billing, privacy, or placement boundaries"
    );
  });

  it("fails when a required saved route is unavailable or fallback is enabled", async () => {
    await expect(selectRuntimeMissionWorkerRoute(missionWorker({
      policy: "require",
      providerRouteIds: ["missing-route" as never],
      allowFallback: false
    }))).rejects.toThrow("No currently authorized route");
    await expect(selectRuntimeMissionWorkerRoute(missionWorker({
      policy: "automatic",
      providerRouteIds: [],
      allowFallback: true
    }))).rejects.toThrow("lacks its exact local execution policy");
  });
});

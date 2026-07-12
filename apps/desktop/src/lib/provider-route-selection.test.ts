import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectNativeProviderRoute } from "./provider-route-selection";

const mocks = vi.hoisted(() => ({ listRoutes: vi.fn() }));
vi.mock("../runtime", () => ({ listRuntimeNativeProviderRoutes: mocks.listRoutes }));

const route = {
  id: "provider-route-openai-gpt5", recordType: "provider-route", connectionId: "connection-openai",
  kind: "api-model", displayName: "OpenAI GPT-5", providerFamily: "openai", modelOrRuntimeReference: "gpt-5",
  state: "available", health: { state: "healthy" }, placement: { allowedKinds: ["local-desktop"], requiresCredentialHoldingNode: true },
  boundaries: { privacyBoundary: "member-private", billingBoundary: "account-owned-provider", providerBoundary: "openai", placementBoundary: "local-credential-egress" },
  credentialBinding: { custody: "os-secure-store", state: "available", refreshSupported: false },
  workspaceId: "workspace-1", visibility: "member-private", ownerMemberId: "member-1", authority: "local",
  schemaVersion: 1, revision: 1, createdByInternalUserId: "user-1", createdAt: "2026-07-12T10:00:00Z", updatedAt: "2026-07-12T10:00:00Z"
};

describe("native provider route selection", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.listRoutes.mockResolvedValue([route]); });

  it("returns one workspace-fenced no-fallback route binding", async () => {
    await expect(selectNativeProviderRoute({
      providerId: "openai", model: "gpt-5", requiredInputTokens: 100,
      requiredOutputTokens: 1024, requiresTools: false
    })).resolves.toMatchObject({
      workspaceId: "workspace-1",
      selection: { providerRouteId: "provider-route-openai-gpt5", boundaryPolicyRef: expect.stringContaining("member-private") }
    });
  });

  it("fails closed when the selected model has no current account route", async () => {
    await expect(selectNativeProviderRoute({
      providerId: "openai", model: "gpt-5.2", requiredInputTokens: 100,
      requiredOutputTokens: 1024, requiresTools: false
    })).rejects.toThrow("no authorized provider route");
  });
});

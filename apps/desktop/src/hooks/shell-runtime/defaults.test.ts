import { describe, expect, it } from "vitest";
import {
  ALLOW_PREVIEW_FALLBACKS,
  DEFAULT_IDENTITY_STATUS,
  PREVIEW_ACCOUNT_WORKSPACE_STATUS,
  PREVIEW_IDENTITY_STATUS,
  defaultShellState,
  runtimeOrPreview
} from "./defaults";
import { isSupportedConnectorId } from "./backend-normalization";

describe("shell runtime defaults", () => {
  it("keeps the persisted shell and identity defaults stable", () => {
    expect(defaultShellState).toMatchObject({
      activeItem: "new-chat",
      composerValue: "",
      voiceEnabled: true,
      connectedBackendIds: [],
      selectedModelId: "",
      permissionMode: "trusted-scope"
    });
    expect(DEFAULT_IDENTITY_STATUS).toEqual({
      enabled: false,
      state: "disabled",
      message: "Mivlet account setup is not configured.",
      scopes: []
    });
    expect(PREVIEW_ACCOUNT_WORKSPACE_STATUS).toMatchObject({
      state: "ready",
      accountBound: true,
      activeWorkspace: { localWorkspaceId: "preview-default" },
      activeContextOwner: { internalUserId: "preview-user" }
    });
    expect(PREVIEW_IDENTITY_STATUS).toMatchObject({ enabled: true, state: "signed-in" });
  });

  it("prefers a runtime value and permits the existing test preview fallback", () => {
    expect(runtimeOrPreview("runtime", () => "preview", "unavailable")).toBe("runtime");
    expect(ALLOW_PREVIEW_FALLBACKS).toBe(true);
    expect(runtimeOrPreview(null, () => "preview", "unavailable")).toBe("preview");
  });
});

describe("backend normalization", () => {
  it("recognizes only supported connector ids", () => {
    expect(isSupportedConnectorId("github")).toBe(true);
    expect(isSupportedConnectorId("not-a-connector")).toBe(false);
  });
});

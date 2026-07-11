import { describe, expect, it } from "vitest";
import type { BackendProvider } from "@fable/protocol";
import {
  ALLOW_PREVIEW_FALLBACKS,
  DEFAULT_IDENTITY_STATUS,
  PREVIEW_ACCOUNT_WORKSPACE_STATUS,
  PREVIEW_IDENTITY_STATUS,
  defaultShellState,
  runtimeOrPreview
} from "./defaults";
import {
  acpAuthStateFor,
  isFirstWaveConnectorId,
  localLoopbackCapabilities
} from "./backend-normalization";

function localProvider(
  authState: BackendProvider["authState"],
  tools: boolean
): BackendProvider {
  return {
    id: "ollama",
    label: "Ollama",
    description: "Local loopback test provider",
    backendType: "local-loopback",
    authState,
    capabilities: [],
    models: [
      {
        id: "local-model",
        label: "Local model",
        available: true,
        capabilities: {
          contextWindow: 8_192,
          maxOutputTokens: 2_048,
          streaming: true,
          tools,
          vision: false,
          reasoning: false,
          structuredOutput: false
        }
      }
    ]
  } as BackendProvider;
}

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
      message: "Fable account setup is not configured.",
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
  it.each([
    ["connected", "connected"],
    ["signed-out", "needs-auth"],
    ["not-installed", "install-required"],
    ["auth-failed", "failed"],
    ["unavailable", "unavailable"]
  ] as const)("maps ACP %s to %s", (outcome, authState) => {
    expect(acpAuthStateFor(outcome).authState).toBe(authState);
  });

  it("adds tool capabilities only for a connected tool-capable local model", () => {
    expect(localLoopbackCapabilities(localProvider("connected", true))).toEqual(
      expect.arrayContaining(["tool-requests", "approvals", "file-changes"])
    );
    expect(localLoopbackCapabilities(localProvider("connected", false))).not.toContain(
      "tool-requests"
    );
    expect(localLoopbackCapabilities(localProvider("needs-auth", true))).not.toContain(
      "tool-requests"
    );
  });

  it("recognizes only first-wave connector ids", () => {
    expect(isFirstWaveConnectorId("github")).toBe(true);
    expect(isFirstWaveConnectorId("not-a-connector")).toBe(false);
  });
});

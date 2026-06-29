import { describe, expect, it } from "vitest";
import type { BackendProvider, PermissionMode } from "@fable/protocol";
import { captureExecutionRoute, resolveExecutionRoute } from "./route";

function provider(id: string, connected = true): BackendProvider {
  return {
    id,
    backendType: "native-api",
    label: id,
    description: "",
    authState: connected ? "connected" : "needs-auth",
    capabilities: ["streaming"],
    models: [
      { id: "model-a", label: "A", available: true },
      { id: "model-b", label: "B", available: false }
    ]
  };
}

const PM = "read-only" as PermissionMode;

describe("captureExecutionRoute", () => {
  it("pins to the connected backend at create time", () => {
    const route = captureExecutionRoute(provider("openai"), "model-a", PM);
    expect(route).toEqual({
      policy: "pinned",
      backendId: "openai",
      modelId: "model-a",
      permissionMode: PM
    });
  });

  it("falls back to current-default when no backend is connected", () => {
    const route = captureExecutionRoute(undefined, "model-a", PM);
    expect(route.policy).toBe("current-default");
    expect(route.backendId).toBe("");
  });

  it("uses the backend's first available model when none selected", () => {
    const route = captureExecutionRoute(provider("openai"), "", PM);
    expect(route.modelId).toBe("model-a");
  });
});

describe("resolveExecutionRoute", () => {
  it("honors the pinned backend when still connected", () => {
    const resolved = resolveExecutionRoute(
      { policy: "pinned", backendId: "openai", modelId: "model-a", permissionMode: PM },
      provider("openai")
    );
    expect(resolved?.backend.id).toBe("openai");
    expect(resolved?.model.id).toBe("model-a");
    expect(resolved?.fellBack).toBe(false);
  });

  it("falls back to the default backend when the pinned one is gone", () => {
    const resolved = resolveExecutionRoute(
      { policy: "pinned", backendId: "anthropic", modelId: "claude", permissionMode: PM },
      provider("openai")
    );
    expect(resolved?.backend.id).toBe("openai");
    expect(resolved?.fellBack).toBe(true);
  });

  it("returns null when no backend is connected", () => {
    const resolved = resolveExecutionRoute(
      { policy: "pinned", backendId: "openai", modelId: "model-a", permissionMode: PM },
      undefined
    );
    expect(resolved).toBeNull();
  });

  it("returns null when the default backend has no available model", () => {
    const noModels: BackendProvider = {
      ...provider("openai"),
      models: [{ id: "x", label: "x", available: false }]
    };
    const resolved = resolveExecutionRoute(
      { policy: "current-default", backendId: "", modelId: "", permissionMode: PM },
      noModels
    );
    expect(resolved).toBeNull();
  });

  it("resolves current-default to the connected backend's first model", () => {
    const resolved = resolveExecutionRoute(
      { policy: "current-default", backendId: "", modelId: "", permissionMode: PM },
      provider("openai")
    );
    expect(resolved?.backend.id).toBe("openai");
    expect(resolved?.model.id).toBe("model-a");
    expect(resolved?.fellBack).toBe(false);
  });
});

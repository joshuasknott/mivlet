import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeAdapterForTest,
  selectRuntimeAdapterForTest,
} from "../adapters/select";
import {
  configureEventIngress,
  getEventIngress,
  listEventDeliveries,
  previewEventTemplate,
  restoreEventIngress,
  saveEventTrigger,
} from "./event-automations";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
afterEach(() => {
  clearRuntimeAdapterForTest();
  vi.clearAllMocks();
});
describe("native event automation boundary", () => {
  it("fails closed in browser preview for every event operation", async () => {
    selectRuntimeAdapterForTest("preview");
    const event = {
      source: { kind: "signed-json" as const, sourceId: "ci" },
      fields: ["summary"],
      maxAgeSeconds: 300,
      validUntil: "2030-10-09T12:00:00Z",
    };
    for (const call of [
      () => getEventIngress("workspace"),
      () => restoreEventIngress("workspace"),
      () =>
        configureEventIngress({
          workspaceId: "workspace",
          enabled: true,
          port: 24138,
        }),
      () => listEventDeliveries("workspace", "trigger"),
      () =>
        previewEventTemplate({ event, prompt: "Inspect", sampleJson: "{}" }),
      () =>
        saveEventTrigger({
          workspaceId: "workspace",
          id: "trigger",
          agentId: "agent",
          providerId: "openai",
          model: "model",
          permissionMode: "read-only",
          prompt: "Inspect",
          event,
          signingKeyId: "webhook-key:reference",
        }),
    ]) {
      await expect(call()).rejects.toThrow("require the installed desktop app");
    }
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it("passes explicit workspace and trigger identity to the native store", async () => {
    selectRuntimeAdapterForTest("native");
    native.invoke.mockResolvedValue([]);
    await listEventDeliveries("workspace", "trigger");
    expect(native.invoke).toHaveBeenCalledWith("event_delivery_list", {
      request: { workspaceId: "workspace", scheduleId: "trigger" },
    });
    await configureEventIngress({
      workspaceId: "workspace",
      enabled: false,
      port: 24138,
    });
    expect(native.invoke).toHaveBeenCalledWith("event_ingress_configure", {
      request: { workspaceId: "workspace", enabled: false, port: 24138 },
    });
  });
});

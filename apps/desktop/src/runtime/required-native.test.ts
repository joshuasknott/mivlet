import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearRuntimeAdapterForTest,
  selectRuntimeAdapterForTest,
} from "./adapters/select";
import { invokeRequiredNative } from "./required-native";
import { listLocalProjects } from "./domains/local-projects";
import { getPhoneRelayStatus } from "./domains/phone-relay";
import { getMcpServerStatus } from "./domains/mcp-server";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
beforeEach(() => {
  mocks.invoke.mockReset();
  selectRuntimeAdapterForTest("native");
});
afterEach(clearRuntimeAdapterForTest);

it("rejects browser calls with each surface's prerequisite instead of dispatching", async () => {
  selectRuntimeAdapterForTest("preview");
  await expect(listLocalProjects("workspace-a")).rejects.toThrow(
    "Projects require the installed desktop app.",
  );
  await expect(getPhoneRelayStatus()).rejects.toThrow(
    "Connect your phone in the signed-in Mivlet desktop app.",
  );
  await expect(getMcpServerStatus()).rejects.toThrow(
    "External assistants require the signed-in Mivlet desktop app.",
  );
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("preserves request nesting, no-argument commands, and native result identity", async () => {
  const result = { id: "unchanged-native-result" };
  mocks.invoke.mockResolvedValue(result);
  await expect(listLocalProjects("workspace-a", true)).resolves.toBe(result);
  expect(mocks.invoke).toHaveBeenLastCalledWith("local_project_list", {
    request: { workspaceId: "workspace-a", includeArchived: true },
  });
  await expect(getPhoneRelayStatus()).resolves.toBe(result);
  expect(mocks.invoke).toHaveBeenLastCalledWith("phone_relay_status");
});

it("retains structured error metadata and original Error instances", async () => {
  mocks.invoke.mockRejectedValueOnce({
    message: "Review changed",
    code: "stale_review",
    retryable: false,
  });
  await expect(
    invokeRequiredNative("command", { request: {} }, "Desktop required"),
  ).rejects.toMatchObject({
    message: "Review changed",
    code: "stale_review",
    retryable: false,
  });
  const original = new Error("Original native error");
  mocks.invoke.mockRejectedValueOnce(original);
  await expect(getMcpServerStatus()).rejects.toBe(original);
});

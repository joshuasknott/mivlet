import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  keyRuntimeLocalBrowser,
  listRuntimeLocalComputerFiles,
  loadRuntimeLocalComputer,
  navigateRuntimeLocalBrowser,
  pointRuntimeLocalBrowser,
  previewRuntimeLocalComputerFile,
  provisionRuntimeLocalComputer,
  setRuntimeLocalComputerController,
  snapshotRuntimeLocalBrowser,
} from "./runtime";
import { selectRuntimeAdapterForTest } from "./runtime/adapters/select";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

function setNative(enabled: boolean) {
  selectRuntimeAdapterForTest(enabled ? "native" : "preview");
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: enabled ? {} : undefined,
  });
}

describe("local computer runtime boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setNative(false);
  });

  it("does not simulate a local computer in browser preview", async () => {
    const target = { workspaceId: "workspace-a", agentId: "agent-a" };
    await expect(loadRuntimeLocalComputer(target)).resolves.toBeNull();
    await expect(provisionRuntimeLocalComputer(target)).resolves.toBeNull();
    await expect(listRuntimeLocalComputerFiles(target)).resolves.toBeNull();
    await expect(previewRuntimeLocalComputerFile({ ...target, path: "notes/plan.md" })).resolves.toBeNull();
    await expect(snapshotRuntimeLocalBrowser(target)).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("keeps profiles, DevTools endpoints, and input handling behind fixed native commands", async () => {
    setNative(true);
    mocks.invoke.mockResolvedValue({
      computerId: "local-computer-a",
      generation: 4,
      controller: "human",
    });
    const target = { workspaceId: "workspace-a", agentId: "agent-a" };
    await loadRuntimeLocalComputer(target);
    await provisionRuntimeLocalComputer(target);
    await listRuntimeLocalComputerFiles(target);
    await previewRuntimeLocalComputerFile({ ...target, path: "notes/plan.md" });
    await snapshotRuntimeLocalBrowser(target);
    await navigateRuntimeLocalBrowser({ ...target, url: "https://example.com/" });
    await setRuntimeLocalComputerController({
      ...target,
      controller: "human",
      expectedGeneration: 3,
    });
    await pointRuntimeLocalBrowser({
      ...target,
      action: "click",
      expectedGeneration: 4,
      x: 320,
      y: 240,
    });
    await keyRuntimeLocalBrowser({ ...target, expectedGeneration: 4, key: "Enter" });

    expect(mocks.invoke.mock.calls).toEqual([
      ["local_computer_status", target],
      ["local_computer_provision", target],
      ["local_computer_files", { target }],
      ["local_computer_file_preview", { request: { ...target, path: "notes/plan.md" } }],
      ["local_browser_snapshot", { target }],
      ["local_browser_navigate", { request: { ...target, url: "https://example.com/" } }],
      ["local_computer_set_controller", { request: { ...target, controller: "human", expectedGeneration: 3 } }],
      ["local_browser_pointer", { request: { ...target, action: "click", expectedGeneration: 4, x: 320, y: 240 } }],
      ["local_browser_key", { request: { ...target, expectedGeneration: 4, key: "Enter" } }],
    ]);
    const serialized = JSON.stringify(mocks.invoke.mock.calls);
    expect(serialized).not.toContain("browser-profile");
    expect(serialized).not.toContain("DevTools");
    expect(serialized).not.toContain("cookie");
  });

  it("surfaces native setup failures without inventing a fallback", async () => {
    setNative(true);
    mocks.invoke.mockRejectedValueOnce({ message: "A supported Chromium browser is required." });
    await expect(provisionRuntimeLocalComputer({ workspaceId: "workspace-a", agentId: "agent-a" }))
      .rejects.toThrow("A supported Chromium browser is required.");
  });
});

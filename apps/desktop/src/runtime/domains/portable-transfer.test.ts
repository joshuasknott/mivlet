import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearActiveRuntimeDataScope,
  setActiveRuntimeDataScope,
} from "../../runtime-scope";
import {
  exportPortableTransfer,
  importPortableTransfer,
} from "./portable-transfer";

const mock = vi.hoisted(() => ({ invoke: vi.fn(), kind: "native" }));
vi.mock("../adapters/select", () => ({
  getRuntimeAdapter: () => ({ kind: mock.kind, invoke: mock.invoke }),
}));
beforeEach(() => {
  vi.resetAllMocks();
  mock.kind = "native";
  setActiveRuntimeDataScope("default", "account");
});
afterEach(() => clearActiveRuntimeDataScope());

it("passes only the selected workspace; native owns secrets and file selection", async () => {
  mock.invoke.mockResolvedValue({});
  await exportPortableTransfer();
  await importPortableTransfer();
  expect(mock.invoke.mock.calls).toEqual([
    ["portable_transfer_export", { workspaceId: "default" }],
    ["portable_transfer_import", { workspaceId: "default" }],
  ]);
});

it("browser preview cannot synthesize a successful transfer", async () => {
  mock.kind = "preview";
  await expect(importPortableTransfer()).rejects.toThrow("desktop app");
  expect(mock.invoke).not.toHaveBeenCalled();
});

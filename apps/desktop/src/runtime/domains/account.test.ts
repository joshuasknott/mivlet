import { afterEach, expect, it, vi } from "vitest";
import { beginRuntimeIdentitySignIn } from "./account";
import {
  clearRuntimeAdapterForTest,
  selectRuntimeAdapterForTest,
} from "../adapters/select";
const mocks = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
afterEach(() => {
  clearRuntimeAdapterForTest();
  mocks.invoke.mockClear();
});
it.each(["sign-in", "sign-up"] as const)(
  "preserves %s at the native boundary",
  async (mode) => {
    selectRuntimeAdapterForTest("native");
    await beginRuntimeIdentitySignIn(mode);
    expect(mocks.invoke).toHaveBeenCalledWith("identity_begin_sign_in", {
      mode,
    });
  },
);

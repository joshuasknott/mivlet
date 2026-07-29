import type { RuntimeAdapter, RuntimeAdapterKind } from "../ports";
import { nativeRuntimeAdapter } from "./native";
import { previewRuntimeAdapter } from "./preview";

function detectRuntimeAdapter(): RuntimeAdapter {
  return typeof window !== "undefined" &&
    Boolean(
      (window as Window & { __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__,
    )
    ? nativeRuntimeAdapter
    : previewRuntimeAdapter;
}

// Production selects its authority boundary once for the lifetime of this
// renderer. Tests can explicitly replace it because jsdom exercises both
// adapters inside one module instance.
const selectedRuntimeAdapter = detectRuntimeAdapter();
let testRuntimeAdapter: RuntimeAdapter | undefined;

export function getRuntimeAdapter(): RuntimeAdapter {
  return testRuntimeAdapter ?? selectedRuntimeAdapter;
}

export function hasNativeRuntimeAdapter() {
  return getRuntimeAdapter().kind === "native";
}

export function selectRuntimeAdapterForTest(kind: RuntimeAdapterKind) {
  if (!import.meta.env.MODE.includes("test")) {
    throw new Error("Runtime adapter overrides are test-only.");
  }
  testRuntimeAdapter =
    kind === "native" ? nativeRuntimeAdapter : previewRuntimeAdapter;
}

export function clearRuntimeAdapterForTest() {
  if (!import.meta.env.MODE.includes("test")) {
    throw new Error("Runtime adapter overrides are test-only.");
  }
  testRuntimeAdapter = undefined;
}

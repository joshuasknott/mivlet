/** Current provider catalogue shown by onboarding and Settings. */

import type { BackendProvider } from "@fable/protocol";
import { resolveCodexProvider } from "./codex";
import { resolveNativeProvider } from "./native";

export const BACKEND_PROVIDER_IDS = [
  "codex",
  "openai",
  "anthropic",
  "gemini",
  "xai",
  "custom"
] as const;

export type BackendProviderId = (typeof BACKEND_PROVIDER_IDS)[number];
export type { NativeProviderId } from "./catalog";

export function listBackendProviders(): BackendProvider[] {
  return [
    resolveCodexProvider("needs-auth"),
    resolveNativeProvider("openai", "needs-auth"),
    resolveNativeProvider("anthropic", "needs-auth"),
    resolveNativeProvider("gemini", "needs-auth"),
    resolveNativeProvider("xai", "needs-auth"),
    resolveNativeProvider("custom", "needs-auth")
  ];
}

export { resolveCapabilities, hasCapability } from "./capabilities";
export { resolveCodexProvider } from "./codex";
export { resolveNativeProvider, NATIVE_BACKEND_TYPE } from "./native";

/** Current provider catalogue shown by onboarding and Settings. */

import type { BackendProvider } from "@fable/protocol";
import { BUILT_IN_PROVIDER_DRIVERS } from "./driver-registry";

export const BACKEND_PROVIDER_IDS = [
  "codex",
  "openai",
  "claude",
  "anthropic",
  "antigravity",
  "grok",
  "xai",
  "deepseek",
  "cursor",
  "opencode",
  "custom"
] as const;

export type BackendProviderId = (typeof BACKEND_PROVIDER_IDS)[number];
export type { NativeProviderId } from "./catalog";

export function listBackendProviders(): BackendProvider[] {
  return BUILT_IN_PROVIDER_DRIVERS.map((driver) => driver.createProvider());
}

export { resolveCapabilities, hasCapability } from "./capabilities";
export { resolveCodexProvider } from "./codex";
export { resolveAntigravityProvider, ANTIGRAVITY_BACKEND_TYPE } from "./antigravity";
export { resolveManagedProvider } from "./managed";
export {
  BUILT_IN_PROVIDER_DRIVERS,
  providerDriverForInstance,
  type ProviderDriverDefinition
} from "./driver-registry";
export { resolveNativeProvider, NATIVE_BACKEND_TYPE } from "./native";

import type {
  BackendAuthState,
  BackendProvider,
  ProviderDriverKind,
} from "@fable/protocol";
import { resolveAntigravityProvider } from "./antigravity";
import { resolveCodexProvider } from "./codex";
import { resolveManagedProvider } from "./managed";
import { resolveNativeProvider } from "./native";

export interface ProviderDriverDefinition {
  driverKind: ProviderDriverKind;
  defaultInstanceId: string;
  familyId: string;
  category: "account" | "api" | "custom";
  createProvider: (authState?: BackendAuthState) => BackendProvider;
}

/**
 * The installed provider drivers in display order. Adding a provider should be
 * a registry entry plus its adapter; the shell and catalogue do not need a new
 * provider-id switch.
 */
export const BUILT_IN_PROVIDER_DRIVERS: readonly ProviderDriverDefinition[] = [
  {
    driverKind: "codex",
    defaultInstanceId: "codex",
    familyId: "openai",
    category: "account",
    createProvider: (authState = "needs-auth") =>
      resolveCodexProvider(authState),
  },
  {
    driverKind: "native-api",
    defaultInstanceId: "openai",
    familyId: "openai",
    category: "api",
    createProvider: (authState = "needs-auth") =>
      resolveNativeProvider("openai", authState),
  },
  {
    driverKind: "claude-agent",
    defaultInstanceId: "claude",
    familyId: "anthropic",
    category: "account",
    createProvider: (authState = "install-required") =>
      resolveManagedProvider("claude", authState),
  },
  {
    driverKind: "native-api",
    defaultInstanceId: "anthropic",
    familyId: "anthropic",
    category: "api",
    createProvider: (authState = "needs-auth") =>
      resolveNativeProvider("anthropic", authState),
  },
  {
    driverKind: "antigravity-acp",
    defaultInstanceId: "antigravity",
    familyId: "antigravity",
    category: "account",
    createProvider: (authState = "install-required") =>
      resolveAntigravityProvider(authState),
  },
  {
    driverKind: "grok-acp",
    defaultInstanceId: "grok",
    familyId: "xai",
    category: "account",
    createProvider: (authState = "install-required") =>
      resolveManagedProvider("grok", authState),
  },
  {
    driverKind: "native-api",
    defaultInstanceId: "xai",
    familyId: "xai",
    category: "api",
    createProvider: (authState = "needs-auth") =>
      resolveNativeProvider("xai", authState),
  },
  {
    driverKind: "native-api",
    defaultInstanceId: "deepseek",
    familyId: "deepseek",
    category: "api",
    createProvider: (authState = "needs-auth") =>
      resolveNativeProvider("deepseek", authState),
  },
  {
    driverKind: "cursor-acp",
    defaultInstanceId: "cursor",
    familyId: "cursor",
    category: "account",
    createProvider: (authState = "install-required") =>
      resolveManagedProvider("cursor", authState),
  },
  {
    driverKind: "opencode",
    defaultInstanceId: "opencode",
    familyId: "opencode",
    category: "account",
    createProvider: (authState = "install-required") =>
      resolveManagedProvider("opencode", authState),
  },
  {
    driverKind: "native-api",
    defaultInstanceId: "custom",
    familyId: "custom",
    category: "custom",
    createProvider: (authState = "needs-auth") =>
      resolveNativeProvider("custom", authState),
  },
];

export function providerDriverForInstance(
  instanceId: string,
): ProviderDriverDefinition | undefined {
  return BUILT_IN_PROVIDER_DRIVERS.find(
    (driver) => driver.defaultInstanceId === instanceId,
  );
}

import type { BackendProvider, ProviderDriverKind } from "@fable/protocol";
import type {
  AgentBackend,
  AgentBackendFactory,
  BackendDeps,
} from "./contract";
import { createAntigravityBackend } from "./adapters/antigravity";
import { resolveCodexBackend } from "./adapters/codex";
import { createNativeApiBackend } from "./adapters/native-api";
import { createManagedRuntimeBackend } from "./adapters/managed";

const ADAPTER_FACTORIES = new Map<ProviderDriverKind, AgentBackendFactory>([
  ["native-api", createNativeApiBackend],
  ["codex", resolveCodexBackend],
  ["antigravity-acp", createAntigravityBackend],
  ["claude-agent", createManagedRuntimeBackend],
  ["cursor-acp", createManagedRuntimeBackend],
  ["grok-acp", createManagedRuntimeBackend],
  ["opencode", createManagedRuntimeBackend],
]);

export function hasRegisteredAdapter(driverKind: string): boolean {
  return ADAPTER_FACTORIES.has(driverKind as ProviderDriverKind);
}

export function createRegisteredBackend(
  provider: BackendProvider,
  deps: BackendDeps,
): AgentBackend | null {
  const legacyDriverKind: ProviderDriverKind =
    provider.backendType === "codex-app-server"
      ? "codex"
      : provider.backendType === "antigravity-acp"
        ? "antigravity-acp"
        : "native-api";
  return (
    ADAPTER_FACTORIES.get(provider.driverKind ?? legacyDriverKind)?.(
      provider,
      deps,
    ) ?? null
  );
}

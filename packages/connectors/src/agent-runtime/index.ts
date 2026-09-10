/**
 * Provider-neutral agent-runtime barrel.
 *
 * Exposes the {@link AgentBackend} contract, the {@link resolveAgentBackend}
 * factory, and the {@link BackendDeps} injection seam. The shell imports these
 * to resolve a connected backend to a runnable adapter; the adapters themselves
 * (native API and Codex) are implementation details exposed only for
 * direct testing.
 */

export type {
  AgentBackend,
  EmbeddedRuntimeHandle,
  EmbeddedRuntimeEvent,
  AntigravityAcpEvent,
  AntigravityAcpHandle,
  AntigravityAcpHandlers,
  ManagedRuntimeEvent,
  ManagedRuntimeHandle,
  ManagedRuntimeHandlers,
  BackendDeps,
  CodexAppServerEvent,
  CodexAppServerHandle,
  CodexAppServerHandlers,
  CodexThreadRef,
  CodexTurnRequest,
  TransportHandlers,
  TransportHandle,
  AgentBackendFactory,
} from "./contract";
export type { AgentTurnRequest, AgentTurnOptions } from "@fable/protocol";
export { resolveAgentBackend, hasRunnableAdapter } from "./factory";
// Adapter constructors are exported for direct unit testing; production code
// reaches them only through resolveAgentBackend.
export { createNativeApiBackend } from "./adapters/native-api";
export { createCodexBackend } from "./adapters/codex";
export { createAntigravityBackend } from "./adapters/antigravity";
export { createManagedRuntimeBackend } from "./adapters/managed";
export {
  MockCodexAppServer,
  MockHttpTransport,
} from "./testing/fake-backend-utils";
export {
  redactSecretsFromString,
  redactSecretsFromObject,
} from "./utils/redact";
export {
  BackendRuntimeError,
  backendErrorEvent,
  classifyBackendError,
  normalizeBackendErrorEvent,
  type BackendErrorMetadata,
} from "./utils/errors";

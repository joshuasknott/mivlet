/**
 * Provider-neutral agent-runtime barrel.
 *
 * Exposes the {@link AgentBackend} contract, the {@link resolveAgentBackend}
 * factory, and the {@link BackendDeps} injection seam. The shell imports these
 * to resolve a connected backend to a runnable adapter; the adapters themselves
 * (native-api, codex, acp, copilot) are implementation details exposed only for
 * direct testing.
 */

export type {
  AgentBackend,
  BackendDeps,
  CodexAppServerEvent,
  CodexAppServerHandle,
  CodexAppServerHandlers,
  CodexThreadRef,
  CodexTurnRequest,
  TransportHandlers,
  TransportHandle,
  AgentBackendFactory
} from "./contract";
export type { AgentRunRequest, AgentRunOptions } from "@fable/protocol";
export { resolveAgentBackend, hasRunnableAdapter } from "./factory";
// Adapter constructors are exported for direct unit testing; production code
// reaches them only through resolveAgentBackend.
export { createNativeApiBackend } from "./adapters/native-api";
export { createCodexBackend } from "./adapters/codex";
export { resolveAcpBackend } from "./adapters/acp";
export {
  ACP_PROVIDERS,
  detectAcpRuntime,
  type AcpProviderDefinition,
  type AcpCliProbe,
  type AcpCliProbeOutcome,
  type AcpRuntimeDetection
} from "./adapters/acp-providers";
export { MockCodexAppServer, MockHttpTransport } from "./testing/fake-backend-utils";
export { redactSecretsFromString, redactSecretsFromObject } from "./utils/redact";

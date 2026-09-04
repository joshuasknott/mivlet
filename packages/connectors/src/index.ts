/**
 * Public barrel for the @fable/connectors package.
 *
 * The desktop shell imports provider-neutral connector logic and the
 * secret-free disconnected catalogue from this surface. Live status, content,
 * and actions always come from the native credential and API boundary.
 */

// logic
export {
  importLocalTextFile,
  localFileFingerprint,
  validateLocalFileCandidate,
  MAX_LOCAL_FILE_BYTES,
  MAX_LOCAL_FILE_PREVIEW_CHARACTERS,
  SUPPORTED_LOCAL_FILE_EXTENSIONS
} from "./local-files";
export type { LocalFileValidation, LocalTextFileCandidate } from "./local-files";
export { searchKnowledgeSources } from "./knowledge-search";
export type { KnowledgeSearchOptions } from "./knowledge-search";
export {
  DEFAULT_CUSTOM_APPROVAL_SETTINGS,
  effectForConnectorAction,
  effectForTool,
  evaluatePermissionPolicy,
  isHighSeverityEffect,
  normalizePermissionProfile,
  normalizeCustomApprovalSettings,
  permissionModeForProfile,
  permissionProfileForMode,
  resolvePermissionModeFromCustom,
  type PermissionEffect,
  type PermissionPolicyDecision,
  type PermissionPolicyInput
} from "./permission-policy";

export {
  connectorCatalog,
  listSupportedConnectors,
  SUPPORTED_CONNECTOR_IDS
} from "./catalog";

// Provider adapters are pure: no network and no credential access.
export {
  classifyConnectorError,
  importConnectorSearchItem,
  prepareConnectorAction,
  shapeConnectorSearchRequest,
  type ProviderErrorLike
} from "./providers/shared";
export * from "./providers/github";
export * from "./providers/vercel";
export * from "./providers/linear";
export * from "./providers/linear-actions";
export * from "./providers/linear-items";
export * from "./providers/google-drive";
export * from "./providers/google-shared";
export * from "./providers/notion";
export * from "./providers/gmail";
export * from "./providers/slack";
export * from "./providers/notion-api";
export * from "./providers/slack-api";
export * from "./providers/http";
export * from "./providers/broker-contract";
export * from "./providers/google-calendar";
export * from "./providers/routing";
export {
  ConnectorRuntime,
  normalizeConnectorError,
  tokenExpiresSoon,
  type ConnectorAccountSession,
  type ConnectorAdapter,
  type ConnectorApprovalBoundary,
  type ConnectorAuthCallback,
  type ConnectorAuthContext,
  type ConnectorAuthResult as SdkConnectorAuthResult,
  type ConnectorAuthStart,
  type ConnectorRequest,
  type ConnectorRuntimeOptions,
  type ConnectorWriteRequest
} from "./sdk";

export * from "./sync";

// agent-runtime backends (logic + data split, mirroring the connector pattern)
export {
  BACKEND_PROVIDER_IDS,
  listBackendProviders,
  BUILT_IN_PROVIDER_DRIVERS,
  providerDriverForInstance,
  resolveCapabilities,
  resolveCodexProvider,
  resolveManagedProvider,
  resolveNativeProvider,
  NATIVE_BACKEND_TYPE
} from "./backends/registry";
export { hasCapability } from "./backends/capabilities";
export type {
  CapabilitySet
} from "./backends/capabilities";
export type {
  BackendProviderId,
  NativeProviderId,
  ProviderDriverDefinition
} from "./backends/registry";

// native-API agent loop (pure shaping + orchestration; the transport seam
// injects egress — Rust owns the key + HTTP/SSE in production). No network, no
// key in any of these modules; tests use recorded fixtures.
export {
  FixtureTransport,
  SequencedFixtureTransport,
  type HttpTransport
} from "./native-api/transport";
export {
  parseOpenAiLine,
  shapeOpenAiRequest,
  streamOpenAiEvents
} from "./native-api/openai-compat";
export {
  newAnthropicState,
  parseAnthropicLine,
  shapeAnthropicRequest,
  streamAnthropicEvents
} from "./native-api/anthropic";
export {
  parseGeminiLine,
  shapeGeminiRequest,
  streamGeminiEvents
} from "./native-api/gemini";
export { buildToolApproval } from "./native-api/approvals";
export { lookupTool, registeredToolSpecs } from "./native-api/tools";
export { priceFor } from "./native-api/pricing";
export {
  catalogueCapabilities,
  MAX_TOKENS_DEFAULT,
  resolveModelCapabilities,
  validateModelForRun,
  type ModelValidation
} from "./native-api/model-catalogue";
export {
  mergeDiscoveredModels,
  type DiscoveredModel,
  type DiscoveryOutcome,
  type ModelDiscoveryResult
} from "./native-api/discovery";
export { runAgentLoop, type ToolExecutor, type RunAgentLoopOptions } from "./native-api/agent-loop";
export { buildContextPrefix } from "./native-api/memory-context";

// Provider-neutral agent-runtime contract. Native API and Codex implement the
// same interface, and no secret crosses this boundary.
export {
  resolveAgentBackend,
  hasRunnableAdapter,
  createCodexBackend,
  createAntigravityBackend,
  createManagedRuntimeBackend,
  createNativeApiBackend,
  type AgentBackend,
  type AgentBackendFactory,
  type AgentTurnRequest,
  type AgentTurnOptions,
  type BackendDeps,
  type AntigravityAcpEvent,
  type AntigravityAcpHandle,
  type AntigravityAcpHandlers,
  type ManagedRuntimeEvent,
  type ManagedRuntimeHandle,
  type ManagedRuntimeHandlers,
  type CodexAppServerEvent,
  type CodexAppServerHandle,
  type CodexAppServerHandlers,
  type CodexThreadRef,
  type CodexTurnRequest,
  type TransportHandle,
  type TransportHandlers,
  BackendRuntimeError,
  backendErrorEvent,
  classifyBackendError,
  normalizeBackendErrorEvent,
  type BackendErrorMetadata
} from "./agent-runtime";
export {
  createApprovalGate,
  createToolExecutor,
  ProductionApprovalGate,
  type ApprovalGate,
  type CreateToolExecutorOptions,
  type DecisionResult,
  type ToolApprovalGate,
  type ToolRuntime
} from "./native-api/tool-executor";
export * from "./voice";

// MCP client core. Process and credential custody stay behind native transport
// adapters; this package owns protocol lifecycle, discovery, and exact-call
// authorization seams shared by STDIO and later Streamable HTTP.
export * from "./mcp/client";
export * from "./mcp/protocol";
export * from "./mcp/connected-source-search";

// Browser automation foundation: pure run/session binding, shared permission
// policy classification, and redacted audit shaping. Live transport is supplied
// by a future native/browser boundary; unavailable runtimes fail closed.
export * from "./browser-automation";

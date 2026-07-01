/**
 * Public barrel for the @fable/connectors package.
 *
 * Re-exports two concerns kept in separate modules:
 *   - logic: local-file import + lexical knowledge search (local-files.ts,
 *     knowledge-search.ts)
 *   - data: fixture-only connector/directive/thread/project/knowledge/automation
 *     catalogs (fixtures.ts)
 *
 * The desktop shell imports these via @fable/connectors; this surface is the
 * package's public protocol and must stay stable.
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

// data (preview/demo fixtures)
export {
  automationFixtures,
  chatThreadFixtures,
  connectorFixtures,
  connectorSearchFixtures,
  directiveFixtures,
  knowledgeSourceFixtures,
  projectFixtures
} from "./fixtures";

// first-wave provider adapters (pure: no network and no credential access)
export {
  FIRST_WAVE_CONNECTOR_IDS,
  importFixtureConnectorItem,
  listFirstWaveConnectors,
  prepareFixtureConnectorAction,
  searchFixtureConnector
} from "./providers/registry";
export {
  classifyConnectorError,
  importConnectorSearchItem,
  prepareConnectorAction,
  searchConnectorFixtures,
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
  resolveAcpProvider,
  resolveCapabilities,
  resolveCodexProvider,
  resolveCopilotProvider,
  resolveCursorProvider,
  resolveGrokProvider,
  resolveNativeProvider,
  NATIVE_BACKEND_TYPE
} from "./backends/registry";
export { hasCapability } from "./backends/capabilities";
export type {
  CapabilitySet
} from "./backends/capabilities";
export type {
  AcpProviderId,
  BackendProviderId,
  NativeProviderId
} from "./backends/registry";
export type { CopilotAuthMode } from "./backends/fixtures";
export { COPILOT_AUTH_MODES } from "./backends/copilot";

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

// provider-neutral agent-runtime contract. One interface every backend family
// (native-API, Codex, ACP, Copilot) implements; the shell resolves one
// AgentBackend per run via resolveAgentBackend. Native-API and ACP (Cursor/Grok)
// have live adapters; Codex and Copilot remain metadata-only until their
// adapters land. No secret crosses this boundary — auth lives behind the Rust
// boundary / provider-owned auth caches (CLI-owned for ACP).
export {
  resolveAgentBackend,
  hasRunnableAdapter,
  createCodexBackend,
  createNativeApiBackend,
  resolveAcpBackend,
  ACP_PROVIDERS,
  detectAcpRuntime,
  type AgentBackend,
  type AgentBackendFactory,
  type AgentRunRequest,
  type AgentRunOptions,
  type BackendDeps,
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
  type BackendErrorMetadata,
  type AcpProviderDefinition,
  type AcpCliProbe,
  type AcpCliProbeOutcome,
  type AcpRuntimeDetection
} from "./agent-runtime";
// Generic ACP protocol surface (provider-neutral JSON-RPC over stdio). Exposed so
// the desktop transport factory can frame/correlate frames; tests drive it via
// the FakeAcpTransport. No provider-specific executable logic lives here.
export {
  parseAcpLine,
  encodeAcpFrame,
  isAcpRequest,
  isAcpResponse,
  isAcpNotification,
  MAX_ACP_FRAME_CHARACTERS,
  type AcpFrame,
  type AcpRequest,
  type AcpResponse,
  type AcpNotification,
  type AcpError,
  type AcpTransport,
  type AcpTransportFactory,
  type AcpTransportProvider,
  type AcpReply
} from "./agent-runtime/adapters/acp/index";
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
export * from "./scheduler";
export * from "./workflows";
export * from "./departments";
export * from "./notifications";
export * from "./voice";

// Fable-owned slash commands (provider-neutral parsing, redaction, dispatch).
// Pure logic; the shell implements the CommandRuntime seam.
export * from "./commands";

// Mobile remote-control foundation: pure session/pairing/authorization/dispatch
// logic for the desktop-side remote-control surface. Secrets (PSK, device keys)
// live behind the Rust boundary. See docs/architecture/mobile-remote.md.
export * from "./mobile-remote";

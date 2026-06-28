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
  MAX_LOCAL_FILE_BYTES,
  MAX_LOCAL_FILE_PREVIEW_CHARACTERS,
  SUPPORTED_LOCAL_FILE_EXTENSIONS
} from "./local-files";
export type { LocalTextFileCandidate } from "./local-files";
export { searchKnowledgeSources } from "./knowledge-search";

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
export * from "./providers/google-drive";
export * from "./providers/notion";
export * from "./providers/gmail";
export * from "./providers/slack";
export * from "./providers/notion-api";
export * from "./providers/slack-api";
export * from "./providers/http";
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
export { runAgentLoop, type ToolExecutor, type RunAgentLoopOptions } from "./native-api/agent-loop";
export { buildContextPrefix } from "./native-api/memory-context";
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

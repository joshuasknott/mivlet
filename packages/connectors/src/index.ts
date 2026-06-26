/**
 * Public barrel for the @arden/connectors package.
 *
 * Re-exports two concerns kept in separate modules:
 *   - logic: local-file import + lexical knowledge search (local-files.ts,
 *     knowledge-search.ts)
 *   - data: fixture-only connector/directive/thread/project/knowledge/automation
 *     catalogs (fixtures.ts)
 *
 * The desktop shell imports these via @arden/connectors; this surface is the
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
  directiveFixtures,
  knowledgeSourceFixtures,
  projectFixtures
} from "./fixtures";

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
export { runAgentLoop, type ToolExecutor, type RunAgentLoopOptions } from "./native-api/agent-loop";
export { buildContextPrefix } from "./native-api/memory-context";
